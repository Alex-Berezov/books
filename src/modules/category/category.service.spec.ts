import { CategoryTreeService } from './category-tree.service';
import { CategoryService } from './category.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TaxonomyIndexabilityService } from '../seo/indexability/taxonomy-indexability.service';
import { SlugRedirectService } from '../slug-redirect/slug-redirect.service';
import { BadRequestException } from '@nestjs/common';
import { Language } from '@prisma/client';

interface PrismaStub {
  $transaction: jest.Mock;
  $queryRaw: jest.Mock;
  category: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    count: jest.Mock;
    findMany: jest.Mock;
  };
  categoryTranslation: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    deleteMany: jest.Mock;
  };
  bookVersion: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
  };
  bookCategory: {
    findFirst: jest.Mock;
    create: jest.Mock;
    delete: jest.Mock;
    deleteMany: jest.Mock;
  };
  bookRating: {
    groupBy: jest.Mock;
  };
}

const createPrismaStub = (): PrismaStub => ({
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
  category: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
    findMany: jest.fn(),
  },
  categoryTranslation: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  },
  bookVersion: { findUnique: jest.fn(), findMany: jest.fn() },
  bookCategory: {
    findFirst: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  },
  bookRating: { groupBy: jest.fn() },
});

describe('CategoryService', () => {
  let service: CategoryService;
  let prisma: PrismaStub;
  let indexability: { recomputeForTerms: jest.Mock };

  beforeEach(() => {
    prisma = createPrismaStub();
    prisma.$transaction = jest
      .fn()
      .mockImplementation((cb: (tx: PrismaStub) => unknown) => cb(prisma as unknown as PrismaStub));
    indexability = { recomputeForTerms: jest.fn().mockResolvedValue(undefined) };
    service = new CategoryService(
      prisma as unknown as PrismaService,
      {
        record: jest.fn().mockResolvedValue(undefined),
        resolve: jest.fn().mockResolvedValue(null),
      } as unknown as SlugRedirectService,
      new CategoryTreeService(prisma as unknown as PrismaService),
      indexability as unknown as TaxonomyIndexabilityService,
    );
  });

  it('update rejects cycle in hierarchy', async () => {
    // Graph: A <- C <- B; set parent(A) = B -> cycle
    const parentMap: Record<string, string | null> = { A: null, B: 'C', C: 'A' };
    // 🔴 Различать чтения надо по **отсутствию** `type`, а не по наличию
    // `parentId`. Подъём `isDescendant` берёт ровно `{ parentId: true }`,
    // а все прочие чтения просят и `type`. Прежнее условие «есть `parentId`
    // в select» поймало и перечитывание термина внутри транзакции
    // (`LEGACY-274`, select `{ id, type, slug, parentId }`): оно получало
    // объект без `type`, `assertSameType` падал первым, и тест зеленел,
    // не дойдя до проверки цикла вовсе.
    prisma.category.findUnique.mockImplementation(
      (args: { where: { id: string }; select?: { parentId?: boolean; type?: boolean } }) => {
        const id: string = args.where.id;
        if (args.select && !args.select.type) {
          return { parentId: parentMap[id] ?? null };
        }
        return {
          id,
          name: 'X',
          slug: 'x',
          type: 'genre',
          parentId: parentMap[id] ?? null,
        };
      },
    );

    await expect(service.update('A', { parentId: 'B' })).rejects.toThrow(
      'Cycle detected in category hierarchy',
    );
  });

  /**
   * 🔴 `LEGACY-266`. Проверка цикла обязана ходить тем же клиентом, которым
   * идёт запись. На клиенте пула между проверкой и `update` помещается чужая
   * транзакция: два одновременных PATCH `A → B` и `B → A` не видят цикла ни
   * один, обе записи коммитятся, дерево замкнуто.
   *
   * ⚠️ Мок `$transaction` отдаёт **отдельный** объект `tx`: пока `tx` — это тот
   * же самый `prisma`, тест не отличает один клиент от другого и дефект
   * проходит незамеченным.
   */
  it('смена родителя читает дерево клиентом транзакции, а не пулом (LEGACY-266)', async () => {
    const parentMap: Record<string, string | null> = { A: null, B: null };
    const reads: string[] = [];
    const readVia = (client: 'pool' | 'tx') =>
      jest.fn((args: { where: { id: string } }) => {
        const id: string = args.where.id;
        reads.push(`${client}:${id}`);
        return Promise.resolve({
          id,
          name: id,
          slug: id.toLowerCase(),
          type: 'genre',
          parentId: parentMap[id] ?? null,
        });
      });

    prisma.category.findUnique = readVia('pool');
    const txUpdate = jest.fn().mockResolvedValue({ id: 'A', parentId: 'B' });
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      category: { findUnique: readVia('tx'), update: txUpdate },
    };
    prisma.$transaction = jest
      .fn()
      .mockImplementation((cb: (client: unknown) => unknown) => cb(tx));

    await service.update('A', { parentId: 'B' });

    // На клиенте пула — только чтение самой категории до транзакции.
    expect(reads.filter((r) => r.startsWith('pool:'))).toEqual(['pool:A']);
    // Родитель и подъём по предкам — уже внутри транзакции.
    expect(reads.filter((r) => r.startsWith('tx:')).length).toBeGreaterThan(0);
    expect(txUpdate).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 `LEGACY-274` + `LEGACY-275` п.3. `create` — второй писатель родительского
   * ребра, и до 29.08.2026 он читал родителя на пуле и писал вовсе без
   * транзакции. Пока это было так, блокировка в `update` не стерегла ничего:
   * одновременные `POST {parentId: P}` и `PATCH P {type}` записывали
   * разнотипное ребро мимо неё.
   *
   * ⚠️ Проверяется порядок, а не факт вызова: блокировка, взятая после чтения
   * родителя, зеленеет на `toHaveBeenCalled` и не стережёт ничего.
   */
  it('создание под родителем берёт блокировку первым оператором и читает родителя через tx (LEGACY-274)', async () => {
    const order: string[] = [];
    // На пуле лежит устаревшая строка: по ней тип совпал бы и проверка прошла.
    prisma.category.findUnique.mockImplementation(() => {
      order.push('pool-read');
      return Promise.resolve({ id: 'P', type: 'genre' });
    });
    const tx = {
      $queryRaw: jest.fn(() => {
        order.push('lock');
        return Promise.resolve([]);
      }),
      category: {
        findUnique: jest.fn(() => {
          order.push('tx-read');
          // В транзакции родитель уже другого типа.
          return Promise.resolve({ id: 'P', type: 'category' });
        }),
        create: jest.fn(() => {
          order.push('write');
          return Promise.resolve({ id: 'C' });
        }),
      },
    };
    prisma.$transaction = jest
      .fn()
      .mockImplementation((cb: (client: unknown) => unknown) => cb(tx));

    await expect(
      service.create({ type: 'genre', name: 'C', slug: 'c', parentId: 'P' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(order[0]).toBe('lock');
    expect(order).toContain('tx-read');
    expect(order).not.toContain('pool-read');
    expect(order).not.toContain('write');
  });

  /**
   * Обратная сторона: корневой термин ребра не пишет, блокировать нечего.
   * Безусловный вызов сериализовал бы массовое заведение терминов.
   *
   * ⚠️ Проверяется отсутствие **блокировки**, а не отсутствие транзакции.
   * С `LEGACY-311` корневой термин тоже пишется транзакцией: проверка
   * занятости слага и сама запись — это «проверил и записал», и на клиенте
   * пула между ними помещается чужой `POST`. Прежнее утверждение
   * `$transaction` не вызывался зеленело бы и на возврате дефекта.
   */
  it('создание без родителя блокировку не берёт (LEGACY-274)', async () => {
    const order: string[] = [];
    const tx = {
      $queryRaw: jest.fn(() => {
        order.push('lock');
        return Promise.resolve([]);
      }),
      category: {
        findFirst: jest.fn(() => {
          order.push('slug-check');
          return Promise.resolve(null);
        }),
        create: jest.fn(() => {
          order.push('write');
          return Promise.resolve({ id: 'C' });
        }),
      },
    };
    prisma.$transaction = jest
      .fn()
      .mockImplementation((cb: (client: unknown) => unknown) => cb(tx));

    await service.create({ type: 'genre', name: 'C', slug: 'c' } as never);

    expect(order).toEqual(['slug-check', 'write']);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  /**
   * 🔴 `LEGACY-311`. `update` отвергал занятый слаг, `create` — нет: `POST`
   * с занятым слагом и свободным ключом проходил с 201 и заводил второй
   * термин на тот же публичный адрес. Уникальности на `Category.slug` в схеме
   * нет (`LEGACY-276`), поэтому база такую пару не отвергает — отвергать
   * должен код, и на обоих путях записи.
   */
  it('создание с занятым слагом отвергается, а не заводит второй термин (LEGACY-311)', async () => {
    const create = jest.fn();
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      category: {
        findFirst: jest.fn().mockResolvedValue({ id: 'other' }),
        create,
      },
    };
    prisma.$transaction = jest
      .fn()
      .mockImplementation((cb: (client: unknown) => unknown) => cb(tx));

    await expect(
      service.create({ type: 'genre', name: 'C', slug: 'taken' } as never),
    ).rejects.toThrow('Category with same slug already exists');
    expect(create).not.toHaveBeenCalled();
  });

  /**
   * Вторая половина `LEGACY-311`: `P2002` сюда может прийти **только по ключу**
   * — индекс `Category_slug_key` снесён миграцией
   * `20250830151000_add_taxonomy_translations`. Прежний текст называл слаг,
   * и оператор менял слаг, получая тот же 400 сколько угодно раз.
   */
  it('занятый ключ называется ключом, а не слагом (LEGACY-311)', async () => {
    const conflict = Object.assign(new Error('unique'), {
      code: 'P2002',
      meta: { target: ['key'] },
    });
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      category: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockRejectedValue(conflict),
      },
    };
    prisma.$transaction = jest
      .fn()
      .mockImplementation((cb: (client: unknown) => unknown) => cb(tx));

    await expect(
      service.create({ type: 'genre', name: 'C', slug: 'c', key: 'taken' } as never),
    ).rejects.toThrow('Category with same key already exists');
  });

  /**
   * 🔴 `LEGACY-275`. Проверка родителя стояла под `if (dto.parentId)`, а `type`
   * записывался безусловно. `PATCH { type }` без `parentId` не запускал её
   * вовсе — и термин оставался ребром под родителем чужого типа: из своего
   * дерева пропадал, в чужом всплывал корнем (`getTree` отбирает по `type`).
   *
   * ⚠️ Родитель здесь **не приходит в теле** — он берётся из базы. Спека,
   * подставляющая `parentId` в DTO, зеленеет и на дефекте.
   */
  it('PATCH только с type проверяет фактического родителя из базы (LEGACY-275)', async () => {
    const rows: Record<
      string,
      { id: string; type: string; slug: string; parentId: string | null }
    > = {
      A: { id: 'A', type: 'genre', slug: 'a', parentId: 'P' },
      P: { id: 'P', type: 'genre', slug: 'p', parentId: null },
    };
    prisma.category.findUnique.mockImplementation((args: { where: { id: string } }) =>
      Promise.resolve(rows[args.where.id] ?? null),
    );
    const txUpdate = jest.fn();
    prisma.category.update = txUpdate;

    await expect(service.update('A', { type: 'category' as never })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(txUpdate).not.toHaveBeenCalled();
  });

  /**
   * Обратная сторона того же условия: PATCH, не трогающий ни родителя, ни тип,
   * не должен платить подъёмом по дереву. Иначе переименование категории
   * начинает стоить столько же, сколько смена родителя.
   */
  it('PATCH без смены родителя и типа не поднимается по дереву (LEGACY-275)', async () => {
    const rows: Record<
      string,
      { id: string; type: string; slug: string; parentId: string | null }
    > = {
      A: { id: 'A', type: 'genre', slug: 'a', parentId: 'P' },
      P: { id: 'P', type: 'genre', slug: 'p', parentId: null },
    };
    const reads: string[] = [];
    prisma.category.findUnique.mockImplementation((args: { where: { id: string } }) => {
      reads.push(args.where.id);
      return Promise.resolve(rows[args.where.id] ?? null);
    });
    prisma.category.update = jest.fn().mockResolvedValue(rows.A);

    await service.update('A', { name: 'Renamed' });

    expect(reads.filter((r) => r === 'P')).toEqual([]);
    expect(prisma.category.update).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 `LEGACY-274`, часть без миграции. `exists` читался на клиенте пула до
   * транзакции, а `type` для проверки родителя и `slug` для записи редиректа
   * брались из него. Соседний PATCH, успевший сменить тип, давал проверку
   * по устаревшему типу — ровно ту разнотипную связь, которую стерегут
   * `LEGACY-264` и `LEGACY-005`.
   *
   * ⚠️ Строка на пуле и строка внутри транзакции здесь намеренно РАЗНЫЕ.
   * Спека, где они совпадают, зеленеет и на дефекте.
   */
  it('решение принимается по строке транзакции, а не по чтению на пуле (LEGACY-274)', async () => {
    const stale = { id: 'A', type: 'genre', slug: 'a-old', parentId: null, key: 'a' };
    const fresh = { id: 'A', type: 'category', slug: 'a-new', parentId: null, key: 'a' };
    const parent = { id: 'P', type: 'genre', slug: 'p', parentId: null, key: 'p' };

    // Пул отдаёт устаревшую строку: по ней тип совпал бы с родителем и проверка прошла.
    prisma.category.findUnique.mockResolvedValue(stale);
    prisma.category.findFirst.mockResolvedValue(null);

    const txFindUnique = jest.fn((args: { where: { id: string } }) =>
      Promise.resolve(args.where.id === 'A' ? fresh : parent),
    );
    const txUpdate = jest.fn();
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      category: { findUnique: txFindUnique, update: txUpdate },
    };
    prisma.$transaction = jest
      .fn()
      .mockImplementation((cb: (client: unknown) => unknown) => cb(tx));

    // Тип в теле не приходит: он берётся из строки, и именно из какой — вопрос.
    await expect(service.update('A', { parentId: 'P' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(txUpdate).not.toHaveBeenCalled();
  });

  /**
   * Вторая половина того же дефекта: `recordBaseSlugChange` получал прежний
   * слаг из до-транзакционного `exists`, то есть писал редирект с адреса,
   * который к моменту записи уже сменился, — и настоящий прежний адрес
   * оставался без редиректа (`LEGACY-062`).
   */
  it('редирект прежнего слага пишется от строки транзакции (LEGACY-274)', async () => {
    const stale = { id: 'A', type: 'genre', slug: 'a-stale', parentId: null, key: 'a' };
    const fresh = { id: 'A', type: 'genre', slug: 'a-fresh', parentId: null, key: 'a' };
    const recordBaseSlugChange = jest.fn().mockResolvedValue(undefined);

    prisma.category.findUnique.mockResolvedValue(stale);
    prisma.category.findFirst.mockResolvedValue(null);
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      category: {
        findUnique: jest.fn().mockResolvedValue(fresh),
        update: jest.fn().mockResolvedValue(fresh),
      },
    };
    prisma.$transaction = jest
      .fn()
      .mockImplementation((cb: (client: unknown) => unknown) => cb(tx));

    service = new CategoryService(
      prisma as unknown as PrismaService,
      {
        record: jest.fn().mockResolvedValue(undefined),
        resolve: jest.fn().mockResolvedValue(null),
        recordBaseSlugChange,
      } as unknown as SlugRedirectService,
      new CategoryTreeService(prisma as unknown as PrismaService),
      indexability as unknown as TaxonomyIndexabilityService,
    );

    await service.update('A', { slug: 'a-newest' });

    // Один вызов, а не «хотя бы один»: откат, дописавший второй вызов
    // с устаревшим слагом рядом с верным, оставил бы проверку зелёной.
    expect(recordBaseSlugChange).toHaveBeenCalledTimes(1);
    expect(recordBaseSlugChange).toHaveBeenCalledWith('category', 'a-fresh', 'a-newest', tx);
  });

  /**
   * 🔴 `LEGACY-274`, гонка. Блокировка обязана быть **первым** оператором
   * транзакции: транзакция, успевшая взять строку категории, встанет на ней
   * во взаимную блокировку с чужой. Порядок и проверяется — сам факт вызова
   * ничего не стоит.
   */
  it('транзакция смены родителя берёт блокировку дерева первым оператором (LEGACY-274)', async () => {
    const order: string[] = [];
    prisma.category.findUnique.mockResolvedValue({
      id: 'A',
      type: 'genre',
      slug: 'a',
      parentId: null,
      key: 'a',
    });
    const tx = {
      $queryRaw: jest.fn(() => {
        order.push('lock');
        return Promise.resolve([]);
      }),
      category: {
        findUnique: jest.fn(() => {
          order.push('read');
          return Promise.resolve({ id: 'A', type: 'genre', slug: 'a', parentId: null });
        }),
        update: jest.fn(() => {
          order.push('write');
          return Promise.resolve({ id: 'A' });
        }),
      },
    };
    prisma.$transaction = jest
      .fn()
      .mockImplementation((cb: (client: unknown) => unknown) => cb(tx));

    // Смена родителя — правка дерева, блокировка обязательна.
    await service.update('A', { parentId: null });

    expect(order[0]).toBe('lock');
    expect(order).toContain('write');
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);

    // 🔴 Обратная сторона: PATCH, не несущий ни `parentId`, ни `type`, дерева
    // не касается и блокировку брать не должен. Безусловный вызов стоил бы 500
    // вместо 200 на переименовании во время импорта: тот держит эту же
    // блокировку до 30 с на термин, а ждущий PATCH удерживает соединение
    // единственного пула, пока не отдаст `P2028`.
    order.length = 0;
    await service.update('A', { name: 'Renamed' });

    expect(order).not.toContain('lock');
    expect(order).toContain('write');
  });

  /**
   * Петля в базе уже могла остаться от прежних версий импорта (`LEGACY-263`):
   * подъём обязан завершиться и на испорченном дереве, иначе публичный
   * `GET /categories/{id}/ancestors` не отвечает **никогда** и держит соединение
   * единственного пула до таймаута клиента.
   *
   * ⚠️ Счётчик обращений, а не голый `await`: зависший обход выглядел бы как
   * молчащий тест, убитый общим таймаутом сьюта, а не как падение этого кейса.
   */
  it('getAncestors завершается на замкнутом дереве (LEGACY-263)', async () => {
    const parentMap: Record<string, string | null> = { A: 'B', B: 'A' };
    let calls = 0;
    prisma.category.findUnique.mockImplementation((args: { where: { id: string } }) => {
      calls += 1;
      if (calls > 100) throw new Error(`Traversal did not terminate: ${calls} lookups`);
      const id: string = args.where.id;
      return {
        id,
        name: id,
        slug: id.toLowerCase(),
        type: 'genre',
        parentId: parentMap[id] ?? null,
      };
    });

    const path = await service.getAncestors('A');

    // ⚠️ Сам `A` в собственные предки не попадает, хотя петля к нему и ведёт:
    // иначе хлебные крошки рисуют категорию своим же родителем.
    expect(path.map((node) => node.id)).toEqual(['B']);
    expect(calls).toBeLessThanOrEqual(4);
  });

  /**
   * 🔴 `LEGACY-303`. Второй край того же ребра, которое стережёт `LEGACY-275`.
   * `PATCH /categories/P {"type":"category"}` на КОРНЕВОМ жанре с детьми:
   * `effectiveParentId === null`, проверка родителя не запускается вовсе, тип
   * записывался, ответ 200 — а в базе оставались рёбра `C(genre) → P(category)`.
   *
   * ⚠️ Термин здесь намеренно корневой. Спека на термине с родителем зеленеет
   * и на дефекте: там 400 приходит от проверки верхнего края.
   */
  it('смена типа корневого термина с детьми чужого типа отвергается (LEGACY-303)', async () => {
    const rows: Record<
      string,
      { id: string; type: string; slug: string; parentId: string | null }
    > = {
      P: { id: 'P', type: 'genre', slug: 'p', parentId: null },
    };
    prisma.category.findUnique.mockImplementation((args: { where: { id: string } }) =>
      Promise.resolve(rows[args.where.id] ?? null),
    );
    // Ребёнок прежнего типа под этим термином.
    prisma.category.findFirst.mockResolvedValue({ id: 'C', type: 'genre' });
    prisma.category.update = jest.fn();

    await expect(service.update('P', { type: 'category' as never })).rejects.toThrow(
      'Child category type mismatch',
    );
    expect(prisma.category.update).not.toHaveBeenCalled();
  });

  /**
   * Обратная сторона: смена типа термина БЕЗ детей обязана проходить —
   * иначе запрет накрыл бы и починку уже испорченного дерева (`LEGACY-263`).
   */
  it('смена типа корневого термина без детей проходит (LEGACY-303)', async () => {
    const rows: Record<
      string,
      { id: string; type: string; slug: string; parentId: string | null }
    > = {
      P: { id: 'P', type: 'genre', slug: 'p', parentId: null },
    };
    prisma.category.findUnique.mockImplementation((args: { where: { id: string } }) =>
      Promise.resolve(rows[args.where.id] ?? null),
    );
    prisma.category.findFirst.mockResolvedValue(null);
    prisma.category.update = jest.fn().mockResolvedValue({ id: 'P', type: 'category' });

    await expect(service.update('P', { type: 'category' as never })).resolves.toEqual({
      id: 'P',
      type: 'category',
    });
    expect(prisma.category.update).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 `LEGACY-306`. Три записи шли независимыми `await` на клиенте пула.
   * Обрыв между второй и третьей оставлял термин без переводов и без связей
   * с книгами: он не показывался ни на одной языковой версии сайта, но
   * продолжал занимать `slug` и `key` и попадать в дерево.
   *
   * ⚠️ Проверяется КЛИЕНТ каждой записи, а не факт вызова: три `await`
   * на пуле дают ровно тот же список вызовов, что и три внутри транзакции.
   */
  it('удаление пишет только клиентом транзакции и берёт блокировку первой (LEGACY-306)', async () => {
    const order: string[] = [];
    const tx = {
      $queryRaw: jest.fn(() => {
        order.push('lock');
        return Promise.resolve([]);
      }),
      category: {
        findUnique: jest.fn(() => {
          order.push('tx.read');
          return Promise.resolve({ id: 'A' });
        }),
        count: jest.fn(() => {
          order.push('tx.count');
          return Promise.resolve(0);
        }),
        delete: jest.fn(() => {
          order.push('tx.category.delete');
          return Promise.resolve({ id: 'A' });
        }),
      },
      bookCategory: {
        deleteMany: jest.fn(() => {
          order.push('tx.bookCategory.deleteMany');
          return Promise.resolve({ count: 0 });
        }),
      },
      categoryTranslation: {
        deleteMany: jest.fn(() => {
          order.push('tx.categoryTranslation.deleteMany');
          return Promise.resolve({ count: 0 });
        }),
      },
    };
    prisma.$transaction = jest
      .fn()
      .mockImplementation((cb: (client: unknown) => unknown) => cb(tx));
    // Записи на пуле обязаны отсутствовать: если хоть одна осталась там,
    // список ниже её не досчитается.
    prisma.bookCategory.deleteMany = jest.fn();
    prisma.categoryTranslation.deleteMany = jest.fn();
    prisma.category.delete = jest.fn();

    await service.remove('A');

    expect(order).toEqual([
      'lock',
      'tx.read',
      'tx.count',
      'tx.bookCategory.deleteMany',
      'tx.categoryTranslation.deleteMany',
      'tx.category.delete',
    ]);
    expect(prisma.bookCategory.deleteMany).not.toHaveBeenCalled();
    expect(prisma.categoryTranslation.deleteMany).not.toHaveBeenCalled();
    expect(prisma.category.delete).not.toHaveBeenCalled();
  });

  /**
   * Вторая половина `LEGACY-306`: отказ на середине не оставляет термин
   * половинчатым. Проверяется тем, что до третьей записи дело не доходит
   * вовсе — откат самой транзакции обеспечивает база, и мок его не показывает.
   */
  it('отказ на удалении переводов не доводит дело до удаления термина (LEGACY-306)', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      category: {
        findUnique: jest.fn().mockResolvedValue({ id: 'A' }),
        count: jest.fn().mockResolvedValue(0),
        delete: jest.fn(),
      },
      bookCategory: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      categoryTranslation: {
        deleteMany: jest.fn().mockRejectedValue(new Error('db is down')),
      },
    };
    prisma.$transaction = jest
      .fn()
      .mockImplementation((cb: (client: unknown) => unknown) => cb(tx));

    await expect(service.remove('A')).rejects.toThrow('db is down');
    expect(tx.category.delete).not.toHaveBeenCalled();
  });

  it('remove rejects when category has children', async () => {
    prisma.category.findUnique.mockResolvedValue({ id: 'A' });
    prisma.category.count.mockResolvedValue(1);
    await expect(service.remove('A')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('getBySlugWithBooks filters versions by effective language and falls back to base slug', async () => {
    prisma.categoryTranslation.findUnique.mockResolvedValue(null);
    prisma.category.findFirst.mockResolvedValue({ id: 'cat1', name: 'Cat', slug: 'cat' });
    const now = new Date();

    (prisma as any).book = {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'b1',
          slug: 'b1',
          createdAt: now,
          updatedAt: now,
          versions: [
            {
              id: 'v-es',
              bookId: 'b1',
              language: Language.es,
              title: 'T2',
              author: 'A',
              description: 'D',
              coverImageUrl: 'u',
              type: 'text',
              isFree: true,
              referralUrl: null,
              createdAt: now,
              updatedAt: now,
              status: 'published',
              publishedAt: now,
              seoId: undefined,
              seo: null,
            },
          ],
        },
        {
          id: 'b2',
          slug: 'b2',
          createdAt: now,
          updatedAt: now,
          versions: [
            {
              id: 'v-en',
              bookId: 'b2',
              language: Language.en,
              title: 'T',
              author: 'A',
              description: 'D',
              coverImageUrl: 'u',
              type: 'text',
              isFree: true,
              referralUrl: null,
              createdAt: now,
              updatedAt: now,
              status: 'published',
              publishedAt: now,
              seoId: undefined,
              seo: null,
            },
          ],
        },
      ]),
    };
    prisma.bookVersion.findMany.mockResolvedValue([
      { language: Language.en },
      { language: Language.es },
    ]);
    prisma.bookRating.groupBy.mockResolvedValue([]);

    const res = await service.getBySlugWithBooks('cat', undefined, 'es, en;q=0.8');
    expect(res.availableLanguages.sort()).toEqual([Language.en, Language.es].sort());
    expect(res.data).toHaveLength(1);
    expect(res.data[0].versions[0].language).toBe(Language.es);
    expect(res.category.translation).toBeNull();
    // `LEGACY-351`: агрегат средней оценки ограничен книгами **этой страницы**
    // (после фильтра по языку — только `b1`), а не всей таблицей `BookRating`.
    // `toHaveBeenCalledTimes(1)` — не только «был вызов с таким where», но и что
    // второго, более широкого вызова (например, без where) в этом пути не было.
    expect(prisma.bookRating.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.bookRating.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { bookId: { in: ['b1'] } } }),
    );
  });

  it('LEGACY-351: getByLangSlugWithBooks ограничивает groupBy книгами своей страницы', async () => {
    prisma.categoryTranslation.findUnique.mockResolvedValue({
      category: { id: 'cat1', name: 'Cat', slug: 'cat' },
      seo: null,
      description: null,
    });
    (prisma as any).book = {
      findMany: jest.fn().mockResolvedValue([
        { id: 'b1', slug: 'b1', versions: [] },
        { id: 'b2', slug: 'b2', versions: [] },
      ]),
    };
    prisma.bookVersion.findMany.mockResolvedValue([]);
    prisma.bookRating.groupBy.mockResolvedValue([]);

    await service.getByLangSlugWithBooks(Language.en, 'cat');

    expect(prisma.bookRating.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.bookRating.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { bookId: { in: ['b1', 'b2'] } } }),
    );
  });

  it('list exposes per-translation indexability (source of truth for the sitemap)', async () => {
    prisma.$transaction = jest
      .fn()
      .mockImplementation((ops: Array<Promise<unknown>>) => Promise.all(ops));
    prisma.category.count.mockResolvedValue(1);
    prisma.category.findMany.mockResolvedValue([
      {
        id: 'c1',
        name: 'Poetry',
        slug: 'poetry',
        key: 'poetry',
        type: 'genre',
        indexable: true,
        isVisible: true,
        sortOrder: 0,
        translations: [
          {
            language: Language.ru,
            name: 'Поэзия',
            slug: 'poeziya',
            bookCount: 1,
            autoIndexable: false,
          },
        ],
      },
    ]);
    prisma.$queryRaw.mockResolvedValue([{ categoryId: 'c1', booksCount: 1 }]);

    const res = await service.list(1, 20, 'genre', Language.ru);

    expect(res.data[0].translations[0]).toEqual(
      expect.objectContaining({ bookCount: 1, autoIndexable: false }),
    );
    expect(res.data[0].autoIndexable).toBe(false);
    expect(res.data[0].langBookCount).toBe(1);
  });

  // LEGACY-117. `Prisma.join([])` бросает TypeError на сборке условия, и публичный
  // список уходил в 500 на пустой выборке. Проверяется именно **отсутствие вызова**
  // `$queryRaw`: код, который зовёт raw и глотает исключение, тоже вернёт пустой
  // список.
  it('list returns an empty page without touching $queryRaw when the page is out of range', async () => {
    prisma.$transaction = jest
      .fn()
      .mockImplementation((ops: Array<Promise<unknown>>) => Promise.all(ops));
    prisma.category.count.mockResolvedValue(42);
    prisma.category.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockRejectedValue(new Error('$queryRaw must not be reached'));

    const res = await service.list(99, 20, 'genre', Language.ru);

    expect(res.data).toEqual([]);
    expect(res.meta).toEqual({ page: 99, limit: 20, total: 42, totalPages: 3 });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  describe('getTree projects per-language indexability', () => {
    beforeEach(() => {
      prisma.category.findMany.mockResolvedValue([
        {
          id: 'c1',
          name: 'Historical Fiction',
          slug: 'historical-fiction',
          key: 'historical-fiction',
          type: 'genre',
          parentId: null,
          indexable: true,
          isVisible: true,
          sortOrder: 0,
          translations: [
            {
              language: Language.en,
              name: 'Historical Fiction',
              slug: 'historical-fiction',
              bookCount: 7,
              autoIndexable: true,
            },
            {
              language: Language.ru,
              name: 'Исторический роман',
              slug: 'istoricheskiy-roman',
              bookCount: 1,
              autoIndexable: false,
            },
          ],
        },
        {
          id: 'c2',
          name: 'Poetry',
          slug: 'poetry',
          key: 'poetry',
          type: 'genre',
          parentId: null,
          indexable: true,
          isVisible: true,
          sortOrder: 1,
          translations: [
            {
              language: Language.en,
              name: 'Poetry',
              slug: 'poetry',
              bookCount: 9,
              autoIndexable: true,
            },
          ],
        },
      ]);
      prisma.$queryRaw.mockResolvedValue([{ categoryId: 'c1', booksCount: 1 }]);
    });

    it('takes autoIndexable from the requested language, not from another one', async () => {
      const roots = await service.getTree('genre', Language.ru);
      const node = roots.find((n) => n.id === 'c1');

      expect(node?.autoIndexable).toBe(false);
      expect(node?.langBookCount).toBe(1);
    });

    it('leaves both fields undefined when lang is not passed', async () => {
      const roots = await service.getTree('genre');

      expect(roots[0].autoIndexable).toBeUndefined();
      expect(roots[0].langBookCount).toBeUndefined();
    });

    it('leaves both fields undefined for a term without a translation into lang', async () => {
      const roots = await service.getTree('genre', Language.ru);
      const node = roots.find((n) => n.id === 'c2');

      expect(node?.autoIndexable).toBeUndefined();
      expect(node?.langBookCount).toBeUndefined();
    });

    it('keeps booksCount live and exposes per-translation indexability', async () => {
      const roots = await service.getTree('genre', Language.ru);
      const node = roots.find((n) => n.id === 'c1');

      expect(node?.booksCount).toBe(1);
      // The sitemap picks a translation by language and needs the same signal there.
      expect(node?.translations).toEqual([
        expect.objectContaining({ language: Language.en, bookCount: 7, autoIndexable: true }),
        expect.objectContaining({ language: Language.ru, bookCount: 1, autoIndexable: false }),
      ]);
    });
  });

  it('detachCategoryFromVersion is idempotent when relation missing', async () => {
    prisma.bookVersion.findUnique = jest.fn().mockResolvedValue({ id: 'v1', bookId: 'b1' });
    prisma.bookVersion.findMany = jest.fn().mockResolvedValue([{ id: 'v1' }]);
    const res = await service.detachCategoryFromVersion('v1', 'c1');
    expect(res).toEqual({ success: true });
  });

  it('detaching a category recomputes that term, not the version', async () => {
    prisma.bookVersion.findUnique = jest.fn().mockResolvedValue({ id: 'v1', bookId: 'b1' });
    prisma.bookVersion.findMany = jest.fn().mockResolvedValue([{ id: 'v1' }]);

    await service.detachCategoryFromVersion('v1', 'c1');

    // After the delete the version no longer points at the term, so only an
    // explicit term-scoped recompute can still reach it.
    expect(indexability.recomputeForTerms).toHaveBeenCalledWith(['c1'], []);
  });

  it('attaching a category recomputes that term', async () => {
    prisma.bookVersion.findUnique = jest.fn().mockResolvedValue({ id: 'v1', bookId: 'b1' });
    prisma.category.findUnique.mockResolvedValue({ id: 'c1' });
    prisma.bookVersion.findMany = jest.fn().mockResolvedValue([{ id: 'v1' }]);
    prisma.bookCategory.findFirst.mockResolvedValue(null);

    await service.attachCategoryToVersion('v1', 'c1');

    expect(indexability.recomputeForTerms).toHaveBeenCalledWith(['c1'], []);
  });

  it('creates a translation that is not indexable until it earns it', async () => {
    prisma.category.findUnique.mockResolvedValue({ id: 'c1' });
    prisma.categoryTranslation.create.mockResolvedValue({ id: 'tr1' });

    await service.createTranslation('c1', {
      language: Language.en,
      name: 'Poetry',
      slug: 'poetry',
    });

    expect(prisma.categoryTranslation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ bookCount: 0, autoIndexable: false }),
      }),
    );
  });
});
