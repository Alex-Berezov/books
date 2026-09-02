import { TAG_TX_OPTIONS, TagLockService } from './tag-lock.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * 🔴 `LEGACY-320`. Замок строки тега держится тремя условиями сразу, и снять
 * можно любое из трёх незаметно:
 *
 * 1. `SELECT ... FOR UPDATE` идёт **первым** оператором транзакции — иначе
 *    транзакция, успевшая тронуть строку, встаёт во взаимную блокировку с чужой;
 * 2. границы транзакции берутся из общей константы, а не из вызывающего —
 *    дефолт Prisma (5 с / 2 с) отдал бы `P2028` и 500 писателю, дождавшемуся
 *    своей очереди (`L-020`);
 * 3. запирается **одна строка**, а не все теги, — иначе админский `PATCH`
 *    встал бы за партией импорта целиком.
 *
 * ⚠️ E2E на живом Postgres (`test/tag-row-lock.e2e-spec.ts`) проверяет только
 * первое и третье: он держит замок около полутора секунд, а дефолтные границы
 * Prisma — пять и две. Снятие `TAG_TX_OPTIONS` на нём не краснеет вовсе,
 * и отказ вылез бы уже на живой партии импорта. Поэтому границы стережёт
 * юнит, а не e2e. Образец рядом — `category/category-tree.service.spec.ts`.
 */
describe('TagLockService.runInLockedTag', () => {
  const makePrisma = (order: string[]) => {
    const tx = {
      // Принимает и шаблон, и вложенные фрагменты: оператор замка написан один
      // раз, а условие подставляется вторым аргументом.
      $queryRaw: jest.fn((parts?: { raw?: readonly string[] }, ...rest: unknown[]) => {
        void rest;
        order.push(`lock:${(parts?.raw ?? []).join(' ')}`);
        return Promise.resolve([]);
      }),
      tag: {
        findUnique: jest.fn(() => {
          order.push('read');
          return Promise.resolve(null);
        }),
      },
    };
    const $transaction = jest.fn((run: (client: unknown) => Promise<unknown>) => run(tx));
    return { prisma: { $transaction } as unknown as PrismaService, tx, $transaction };
  };

  type LockedClient = ReturnType<typeof makePrisma>['tx'];

  /**
   * Оператор написан один раз, ветвится только **условие**: `$queryRaw` получает
   * шаблон первым аргументом и вложенный `Prisma.Sql` вторым. Поэтому и читать
   * надо оба: текст замка — из шаблона, адресацию — из фрагмента.
   */
  const templateOf = (tx: LockedClient): string => {
    const calls = tx.$queryRaw.mock.calls as unknown as Array<[{ raw?: readonly string[] }]>;
    expect(calls).toHaveLength(1);
    return (calls[0][0]?.raw ?? []).join(' ');
  };

  const conditionOf = (tx: LockedClient): { sql: string; values: unknown[] } => {
    const calls = tx.$queryRaw.mock.calls as unknown as Array<[unknown, ...unknown[]]>;
    expect(calls[0]).toHaveLength(2);
    const fragment = calls[0][1] as { sql: string; values: unknown[] };
    return { sql: fragment.sql, values: fragment.values };
  };

  it('тело получает tx уже после замка, а не до него', async () => {
    const order: string[] = [];
    const { prisma, tx } = makePrisma(order);
    const service = new TagLockService(prisma);

    await service.runInLockedTag({ key: 'aestheticism' }, async (client) => {
      await (client as unknown as LockedClient).tag.findUnique();
      return null;
    });

    expect(order.map((step) => step.split(':')[0])).toEqual(['lock', 'read']);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('границы транзакции берутся из общей константы, а не из вызывающего', async () => {
    const { prisma, $transaction } = makePrisma([]);
    const service = new TagLockService(prisma);

    await service.runInLockedTag({ id: 'tag-1' }, () => Promise.resolve(null));

    expect($transaction).toHaveBeenCalledTimes(1);
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), TAG_TX_OPTIONS);
  });

  it('замок берётся на одной строке: есть WHERE и есть FOR UPDATE', async () => {
    const { prisma, tx } = makePrisma([]);
    const service = new TagLockService(prisma);

    await service.runInLockedTag({ key: 'aestheticism' }, () => Promise.resolve(null));

    const template = templateOf(tx);
    expect(template).toContain('FOR UPDATE');
    // Условие обязано быть: `SELECT ... FOR UPDATE` без `WHERE` запер бы
    // всю таблицу тегов — ровно та общая очередь, ради отказа от которой
    // и выбран замок строки (решение арбитра от 03.09.2026).
    expect(template).toContain('WHERE');
    expect(conditionOf(tx).sql).toContain('key =');
    expect(conditionOf(tx).sql).not.toContain('id =');
  });

  it('админский путь адресуется идентификатором, а не ключом', async () => {
    const { prisma, tx } = makePrisma([]);
    const service = new TagLockService(prisma);

    await service.runInLockedTag({ id: 'tag-1' }, () => Promise.resolve(null));

    expect(templateOf(tx)).toContain('FOR UPDATE');
    expect(conditionOf(tx).sql).toContain('id =');
    expect(conditionOf(tx).sql).not.toContain('key =');
  });

  /**
   * ⚠️ Проверяется не отсутствие значения в тексте, а то, что оно лежит
   * в `values` фрагмента: `Prisma.raw` со склейкой утащил бы ключ в `sql`
   * и оставил `values` пустым — а прежняя проверка «в тексте шаблона значения
   * нет» зеленела бы и на такой подмене, потому что значение уехало бы
   * во вложенный фрагмент, а не в шаблон.
   */
  it('значение уходит параметром запроса, а не склейкой в текст SQL', async () => {
    const { prisma, tx } = makePrisma([]);
    const service = new TagLockService(prisma);

    await service.runInLockedTag({ key: "it's a tag" }, () => Promise.resolve(null));

    const condition = conditionOf(tx);
    expect(condition.values).toEqual(["it's a tag"]);
    expect(condition.sql).not.toContain("it's a tag");
    expect(templateOf(tx)).not.toContain("it's a tag");
  });
});
