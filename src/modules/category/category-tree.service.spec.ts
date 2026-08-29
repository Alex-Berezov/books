import { CategoryType } from '@prisma/client';
import {
  CategoryTreeService,
  CATEGORY_TREE_MAX_DEPTH,
  CATEGORY_TREE_TX_OPTIONS,
} from './category-tree.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * Подъём по дереву категорий обязан завершаться на любых данных (`LEGACY-263`).
 *
 * До 20.08.2026 обход был `while (current)` без множества посещённых и без
 * потолка: замкнутое дерево (`A → B → A`) означало не медленный ответ, а
 * бесконечный. `GET /categories/{id}/ancestors` не отвечал никогда и удерживал
 * соединение единственного пула (`LEGACY-256`) до таймаута клиента, а десяток
 * таких запросов клал базу для всего сайта.
 *
 * ⚠️ Проверять «завершается» нужно **счётчиком запросов**, а не `await` без
 * таймаута: зависший обход в jest выглядит как молчащий тест, который убьют
 * по общему таймауту сьюта, а не как падение этого кейса. Фейк ниже считает
 * обращения и сам бросает, перевалив за разумный предел, — тогда причина видна
 * в сообщении.
 */
type Row = { id: string; parentId: string | null };

const MAX_CALLS = CATEGORY_TREE_MAX_DEPTH * 4;

const prismaWith = (rows: Row[]) => {
  const byId = new Map(rows.map((row) => [row.id, row]));
  let calls = 0;
  const findUnique = jest.fn().mockImplementation((args: { where: { id: string } }) => {
    calls += 1;
    if (calls > MAX_CALLS) {
      throw new Error(
        `Traversal did not terminate: ${calls} lookups for a ${rows.length}-node tree`,
      );
    }
    const row = byId.get(args.where.id);
    if (!row) return Promise.resolve(null);
    return Promise.resolve({
      id: row.id,
      name: row.id,
      slug: row.id,
      type: CategoryType.genre,
      parentId: row.parentId,
    });
  });
  return {
    prisma: { category: { findUnique } } as unknown as PrismaService,
    countCalls: () => calls,
  };
};

describe('CategoryTreeService.collectAncestors', () => {
  it('поднимается до корня в здоровом дереве', async () => {
    const { prisma } = prismaWith([
      { id: 'root', parentId: null },
      { id: 'mid', parentId: 'root' },
      { id: 'leaf', parentId: 'mid' },
    ]);
    const service = new CategoryTreeService(prisma);

    const path = await service.collectAncestors('leaf', 'mid');

    expect(path.map((node) => node.id)).toEqual(['mid', 'root']);
  });

  it('завершается на замкнутом дереве, а не висит навсегда (LEGACY-263)', async () => {
    // A → B → A: ровно то, что оставлял импорт до появления проверки на записи.
    const { prisma, countCalls } = prismaWith([
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ]);
    const service = new CategoryTreeService(prisma);
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

    // Подъём от `a`: её родитель `b`, родитель `b` — снова `a`, то есть сам узел.
    // ⚠️ `a` в ответе быть не должно: категория, попавшая к себе же в предки,
    // рисует хлебные крошки, где она сама себе родитель.
    const path = await service.collectAncestors('a', 'b');

    expect(path.map((node) => node.id)).toEqual(['b']);
    expect(countCalls()).toBeLessThanOrEqual(3);
    // Петля не молчит: страница отвечает, но в логе остаётся след, по которому
    // испорченное дерево можно найти и починить.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Cycle detected'));
  });

  it('обрывается по потолку глубины на цепочке длиннее допустимой', async () => {
    const rows: Row[] = Array.from({ length: CATEGORY_TREE_MAX_DEPTH + 10 }, (_, i) => ({
      id: `n${i}`,
      parentId: i === 0 ? null : `n${i - 1}`,
    }));
    const { prisma } = prismaWith(rows);
    const service = new CategoryTreeService(prisma);
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

    const last = rows.length - 1;
    const path = await service.collectAncestors(`n${last}`, `n${last - 1}`);

    expect(path).toHaveLength(CATEGORY_TREE_MAX_DEPTH);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('depth limit'));
  });
});

describe('CategoryTreeService.isDescendant', () => {
  it('находит предка выше по цепочке', async () => {
    const { prisma } = prismaWith([
      { id: 'root', parentId: null },
      { id: 'mid', parentId: 'root' },
      { id: 'leaf', parentId: 'mid' },
    ]);
    const service = new CategoryTreeService(prisma);

    await expect(service.isDescendant('leaf', 'root')).resolves.toBe('yes');
    await expect(service.isDescendant('root', 'leaf')).resolves.toBe('no');
  });

  it('обрывается по потолку глубины, не досчитавшись до дальнего предка', async () => {
    // Цепочка длиннее потолка: корень выше предела, и обход обязан сдаться,
    // а не идти по одному запросу на уровень до бесконечности.
    const rows: Row[] = Array.from({ length: CATEGORY_TREE_MAX_DEPTH + 10 }, (_, i) => ({
      id: `n${i}`,
      parentId: i === 0 ? null : `n${i - 1}`,
    }));
    const { prisma } = prismaWith(rows);
    const service = new CategoryTreeService(prisma);
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

    // ⚠️ Не `no`: обход не дошёл до корня и ответа не знает. Разница решающая —
    // на `no` страж пропустил бы запись в непрочитанную ветку.
    await expect(service.isDescendant(`n${rows.length - 1}`, 'n0')).resolves.toBe('unknown');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('depth limit'));
  });

  it('завершается на замкнутом дереве (LEGACY-263)', async () => {
    const { prisma, countCalls } = prismaWith([
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ]);
    const service = new CategoryTreeService(prisma);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

    // Постороннего узла в петле нет, но и ответить «нет» обход не вправе:
    // ветку он не прочитал, он в ней заблудился.
    await expect(service.isDescendant('a', 'outsider')).resolves.toBe('unknown');
    expect(countCalls()).toBeLessThanOrEqual(3);
  });
});

describe('CategoryTreeService.assertParentAllowed', () => {
  const service = () =>
    new CategoryTreeService(
      prismaWith([
        { id: 'root', parentId: null },
        { id: 'mid', parentId: 'root' },
      ]).prisma,
    );

  it('пропускает законного родителя того же типа', async () => {
    await expect(
      service().assertParentAllowed(
        { id: 'leaf', type: CategoryType.genre },
        { id: 'mid', type: CategoryType.genre },
      ),
    ).resolves.toBeUndefined();
  });

  it('отвергает самоссылку', async () => {
    await expect(
      service().assertParentAllowed(
        { id: 'mid', type: CategoryType.genre },
        { id: 'mid', type: CategoryType.genre },
      ),
    ).rejects.toThrow('Category cannot be parent of itself');
  });

  it('отвергает родителя другого типа (LEGACY-264)', async () => {
    await expect(
      service().assertParentAllowed(
        { id: 'leaf', type: CategoryType.genre },
        { id: 'mid', type: CategoryType.collection },
      ),
    ).rejects.toThrow('Parent category type mismatch');
  });

  it('отказывает, когда ветку предков нового родителя прочитать не удалось', async () => {
    // Петля выше нового родителя: обход в ней блуждает и ответа не приносит.
    // ⚠️ Пропустить такую запись — значит дать оператору, который чинит дерево,
    // дописать в испорченную ветку второе ребро и уйти с ощущением починки.
    const looped = new CategoryTreeService(
      prismaWith([
        { id: 'x', parentId: 'y' },
        { id: 'y', parentId: 'x' },
      ]).prisma,
    );
    jest.spyOn(looped['logger'], 'warn').mockImplementation(() => undefined);

    await expect(
      looped.assertParentAllowed(
        { id: 'leaf', type: CategoryType.genre },
        { id: 'x', type: CategoryType.genre },
      ),
    ).rejects.toThrow('corrupted or too deep to verify');
  });

  it('отвергает родителя, который является потомком (LEGACY-263)', async () => {
    await expect(
      service().assertParentAllowed(
        { id: 'root', type: CategoryType.genre },
        { id: 'mid', type: CategoryType.genre },
      ),
    ).rejects.toThrow('Cycle detected in category hierarchy');
  });
});

/**
 * 🔴 `LEGACY-310`. До 29.08.2026 три условия блокировки из четырёх держались
 * прозой в четырёх комментариях у мест вызова: транзакционный клиент, вызов
 * первым оператором, `xact`-вариант, границы не меньше импортных. Типом было
 * закрыто одно. Пятый писатель дерева получал верный тип и зелёную сборку
 * при неверном порядке — и вставал во взаимную блокировку со встречным PATCH.
 *
 * ⚠️ Проверяется именно ПОРЯДОК, а не факт вызова: блокировка, взятая после
 * первого чтения, зеленеет на `toHaveBeenCalled` и не стережёт ничего.
 */
describe('CategoryTreeService.runInLockedTree', () => {
  const makePrisma = (order: string[]) => {
    const tx = {
      $queryRaw: jest.fn(() => {
        order.push('lock');
        return Promise.resolve([]);
      }),
      category: {
        findUnique: jest.fn(({ where }: { where: { id: string } }) => {
          void where;
          order.push('read');
          return Promise.resolve(null);
        }),
      },
    };
    const $transaction = jest.fn((run: (client: unknown) => Promise<unknown>) => run(tx));
    return { prisma: { $transaction } as unknown as PrismaService, tx, $transaction };
  };

  type LockedClient = ReturnType<typeof makePrisma>['tx'];

  it('тело получает tx уже после блокировки', async () => {
    const order: string[] = [];
    const { prisma } = makePrisma(order);
    const service = new CategoryTreeService(prisma);

    await service.runInLockedTree(async (client) => {
      await (client as unknown as LockedClient).category.findUnique({ where: { id: 'x' } });
      return null;
    });

    expect(order).toEqual(['lock', 'read']);
  });

  it('границы транзакции берутся из общей константы, а не из вызывающего', async () => {
    const { prisma, $transaction } = makePrisma([]);
    const service = new CategoryTreeService(prisma);

    await service.runInLockedTree(() => Promise.resolve(null));

    expect($transaction).toHaveBeenCalledTimes(1);
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), CATEGORY_TREE_TX_OPTIONS);
  });

  it('runInTree даёт те же границы, но блокировку не берёт', async () => {
    const order: string[] = [];
    const { prisma, tx, $transaction } = makePrisma(order);
    const service = new CategoryTreeService(prisma);

    await service.runInTree(async (client) => {
      await (client as unknown as LockedClient).category.findUnique({ where: { id: 'x' } });
      return null;
    });

    expect(order).toEqual(['read']);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect($transaction).toHaveBeenCalledTimes(1);
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), CATEGORY_TREE_TX_OPTIONS);
  });
});

/**
 * 🔴 `LEGACY-303`. Второй край ребра. `assertParentAllowed` смотрит только
 * вверх и только при непустом родителе, поэтому смена типа корневого термина
 * с детьми проходила молча, а в базе оставались рёбра `C(genre) → P(category)`.
 */
describe('CategoryTreeService.assertChildTypesAllowed', () => {
  const prismaWithChild = (child: { id: string; type: CategoryType } | null) => {
    const findFirst = jest.fn().mockResolvedValue(child);
    return {
      prisma: { category: { findFirst } } as unknown as PrismaService,
      findFirst,
    };
  };

  it('отвергает смену типа, когда у термина есть ребёнок прежнего типа', async () => {
    const { prisma } = prismaWithChild({ id: 'child-1', type: CategoryType.genre });
    const service = new CategoryTreeService(prisma);

    await expect(
      service.assertChildTypesAllowed({ id: 'P', type: CategoryType.category }),
    ).rejects.toThrow('Child category type mismatch');
  });

  it('пропускает термин без детей', async () => {
    const { prisma } = prismaWithChild(null);
    const service = new CategoryTreeService(prisma);

    await expect(
      service.assertChildTypesAllowed({ id: 'P', type: CategoryType.category }),
    ).resolves.toBeUndefined();
  });

  /**
   * ⚠️ Читается один несовпадающий ребёнок, а не все дети: список детей
   * корневого термина ничем не ограничен, а ответ нужен двоичный.
   * Спека на `findMany` зеленела бы и на безлимитной выборке.
   */
  it('спрашивает базу об одном несовпадающем ребёнке, а не тянет всех детей', async () => {
    const { prisma, findFirst } = prismaWithChild(null);
    const service = new CategoryTreeService(prisma);

    await service.assertChildTypesAllowed({ id: 'P', type: CategoryType.category });

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledWith({
      where: { parentId: 'P', type: { not: CategoryType.category } },
      select: { id: true, key: true, type: true },
    });
  });

  /**
   * 🔴 Ребёнок, которого та же партия импорта переводит в тот же новый тип,
   * разнотипным ребром не станет — и отвергать по нему нельзя: иначе
   * перетипизация поддерева одним файлом невозможна ни в каком порядке.
   * Решение арбитра от 29.08.2026.
   *
   * ⚠️ Админский `PATCH` зовёт метод без третьего аргумента, и для него
   * запрос обязан остаться прежним — это проверяет кейс выше.
   */
  it('исключает детей, которых та же партия переводит в новый тип', async () => {
    const { prisma, findFirst } = prismaWithChild(null);
    const service = new CategoryTreeService(prisma);

    await service.assertChildTypesAllowed({ id: 'P', type: CategoryType.category }, prisma, [
      'child-key',
    ]);

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        parentId: 'P',
        type: { not: CategoryType.category },
        key: { notIn: ['child-key'] },
      },
      select: { id: true, key: true, type: true },
    });
  });
});
