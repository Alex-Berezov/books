import { CategoryTreeService } from './category-tree.service';
import { CategoryService } from './category.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TaxonomyIndexabilityService } from '../seo/indexability/taxonomy-indexability.service';
import { AdminAuditService } from '../../shared/admin-audit/admin-audit.service';
import { SlugRedirectService } from '../slug-redirect/slug-redirect.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Language, Prisma } from '@prisma/client';

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
    findFirst: jest.Mock;
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
  slugRedirect: {
    deleteMany: jest.Mock;
  };
  seo: {
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  /**
   * Модель `book` общая заглушка не заводит: её подставляют точечно те тесты,
   * которым нужен обход книг каталога. Отсюда необязательность поля.
   */
  book?: {
    count?: jest.Mock;
    findMany: jest.Mock;
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
    findFirst: jest.fn(),
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
  slugRedirect: { deleteMany: jest.fn() },
  seo: { create: jest.fn(), update: jest.fn(), delete: jest.fn() },
});

/**
 * Значения, подставленные в замок **слага** (`LEGACY-276`).
 *
 * ⚠️ Берутся из аргументов тега `$queryRaw`, а не из склеенного текста:
 * у замка дерева ключ — `bigint`, и `JSON.stringify` на нём бросает
 * `TypeError: Do not know how to serialize a BigInt`, то есть проверка падала бы
 * на себе самой, а не на предмете.
 *
 * Вызов отбирается по `hashtext` — тем же признаком, которым спеки различают
 * два замка: общий отбор «любой `$queryRaw`» вернул бы ключ дерева и зеленел
 * бы на подмене одного замка другим.
 */
const slugLockValues = (queryRaw: jest.Mock): unknown[] =>
  (queryRaw.mock.calls as unknown[][])
    .filter((call) => {
      const parts = call[0] as { raw?: readonly string[] } | undefined;
      return (parts?.raw ?? []).join(' ').includes('hashtext');
    })
    .flatMap((call): unknown[] => call.slice(1));

describe('CategoryService', () => {
  let service: CategoryService;
  let prisma: PrismaStub;
  let indexability: { recomputeForTerms: jest.Mock };
  let adminAudit: { record: jest.Mock };
  let slugRedirects: { record: jest.Mock; resolve: jest.Mock; recordBaseSlugChange: jest.Mock };

  beforeEach(() => {
    prisma = createPrismaStub();
    prisma.$transaction = jest
      .fn()
      .mockImplementation((cb: (tx: PrismaStub) => unknown) => cb(prisma as unknown as PrismaStub));
    indexability = { recomputeForTerms: jest.fn().mockResolvedValue(undefined) };
    slugRedirects = {
      record: jest.fn().mockResolvedValue(undefined),
      resolve: jest.fn().mockResolvedValue(null),
      recordBaseSlugChange: jest.fn().mockResolvedValue(undefined),
    };
    adminAudit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new CategoryService(
      prisma as unknown as PrismaService,
      slugRedirects as unknown as SlugRedirectService,
      new CategoryTreeService(prisma as unknown as PrismaService),
      adminAudit as unknown as AdminAuditService,
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
   * 🔴 `LEGACY-276`. Ветка `create` **с родителем** — такой же писатель слага,
   * как остальные три, и замок слага берёт тоже. Без этой спеки снятие
   * `dto.slug` у здешнего `runInLockedTree` не красило ни одного теста:
   * соседняя спека выше меряет один общий `$queryRaw` меткой `lock` и падает
   * на проверке типов раньше, чем дойдёт до проверки слага.
   *
   * ⚠️ Проверяется **порядок двух замков**: дерево, затем слаг. Обратный
   * порядок даёт взаимную блокировку с транзакцией, взявшей их как положено,
   * и `toHaveBeenCalled` на обоих зеленеет и на нём.
   */
  it('создание под родителем берёт замок дерева, затем замок слага (LEGACY-276)', async () => {
    const order: string[] = [];
    prisma.category.findUnique.mockResolvedValue({ id: 'P', type: 'genre' });
    const tx = {
      $queryRaw: jest.fn((parts?: { raw?: readonly string[] }) => {
        const sql = (parts?.raw ?? []).join(' ');
        order.push(sql.includes('hashtext') ? 'lock-slug' : 'lock-tree');
        return Promise.resolve([]);
      }),
      category: {
        findUnique: jest.fn(() => {
          order.push('tx-read');
          return Promise.resolve({ id: 'P', type: 'genre' });
        }),
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

    await service.create({ type: 'genre', name: 'C', slug: 'c', parentId: 'P' } as never);

    expect(order.slice(0, 2)).toEqual(['lock-tree', 'lock-slug']);
    expect(order.indexOf('lock-slug')).toBeLessThan(order.indexOf('slug-check'));
    expect(order.indexOf('slug-check')).toBeLessThan(order.indexOf('write'));
    // Ключ замка — слаг нового термина, а не что-нибудь из строки родителя.
    // Значения берутся из аргументов тега, а не из склеенной строки: ключ
    // дерева — `bigint`, и `JSON.stringify` на нём падает.
    expect(slugLockValues(tx.$queryRaw)).toContain('c');
  });

  /**
   * Обратная сторона: корневой термин ребра не пишет, и очередь **дерева**
   * ему не нужна — безусловный вызов сериализовал бы массовое заведение
   * терминов на очереди импорта (`LEGACY-256`).
   *
   * ⚠️ Проверяется отсутствие блокировки **дерева**, а не отсутствие
   * блокировки вообще: с `LEGACY-276` этот же путь берёт замок по слагу —
   * иначе два одновременных `POST` с одним слагом проходили бы оба, а с релиза 2
   * (`@@unique([slug])`) второй получал бы `P2002` от базы вместо внятного 400
   * от `assertSlugFree`.
   *
   * ⚠️ Замки различаются по тексту запроса, а не одной меткой на оба:
   * общая метка оставила бы спеку зелёной на подмене одного замка другим —
   * ровно то, ради чего то же разведение сделано в спеке импорта.
   */
  it('создание без родителя берёт замок слага, но не замок дерева (LEGACY-274, LEGACY-276)', async () => {
    const order: string[] = [];
    const tx = {
      $queryRaw: jest.fn((parts?: { raw?: readonly string[] }) => {
        const sql = (parts?.raw ?? []).join(' ');
        order.push(sql.includes('hashtext') ? 'lock-slug' : 'lock-tree');
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

    // Замок слага — **первым** оператором, до проверки и до записи: взятый
    // после проверки, он не стережёт ничего (`LEGACY-310`).
    expect(order).toEqual(['lock-slug', 'slug-check', 'write']);
    expect(order).not.toContain('lock-tree');
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
   * Вторая половина `LEGACY-311`: `P2002` **по ключу** обязан называться ключом.
   * Прежний текст называл слаг, и оператор менял слаг, получая тот же 400
   * сколько угодно раз.
   *
   * 🔴 `LEGACY-276`, релиз 2: «по ключу» здесь — про этот кейс, а не про то, что
   * других `P2002` у `Category` не бывает. Индекс `Category_slug_key`, снесённый
   * `20250830151000_add_taxonomy_translations`, возвращён миграцией
   * `20260919170000_legacy_276_category_slug_unique`, и `P2002` по слагу теперь
   * достижим: ветку про слаг в `uniqueViolationMessage` снимать нельзя.
   * Различение полей идёт по `meta.target`.
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
        // `LEGACY-276`: с 19.09.2026 занятость слага проверяется клиентом
        // транзакции, а не пулом — без этой заглушки `assertSlugFree` упадёт
        // на «not a function», а не на настоящем ассершене теста.
        findFirst: jest.fn().mockResolvedValue(null),
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
      { record: jest.fn().mockResolvedValue(undefined) } as unknown as AdminAuditService,
      indexability as unknown as TaxonomyIndexabilityService,
    );

    await service.update('A', { slug: 'a-newest' });

    // Один вызов, а не «хотя бы один»: откат, дописавший второй вызов
    // с устаревшим слагом рядом с верным, оставил бы проверку зелёной.
    expect(recordBaseSlugChange).toHaveBeenCalledTimes(1);
    expect(recordBaseSlugChange).toHaveBeenCalledWith('category', 'a-fresh', 'a-newest', tx);
  });

  /**
   * `LEGACY-276`. Проверок занятости слага при `PATCH` **две**, и решает
   * вторая: дешёвая на пуле даёт быстрый 400 обычной ошибке оператора,
   * настоящая идёт клиентом транзакции под замком по слагу.
   *
   * ⚠️ Пул отвечает «слаг свободен», клиент транзакции — «занят»: тест
   * зеленеет только на том клиенте, который реально решает. Спека, где оба
   * отвечают одинаково, пропустила бы возврат проверки на пул.
   */
  it('update проверяет занятость слага клиентом транзакции, а не пулом (LEGACY-276)', async () => {
    prisma.category.findUnique.mockResolvedValue({
      id: 'A',
      type: 'genre',
      slug: 'a',
      parentId: null,
      key: 'a',
    });
    // Пул сказал бы «свободен» — если бы проверка спрашивала его, тест
    // остался бы зелёным на дефекте.
    prisma.category.findFirst.mockResolvedValue(null);

    const txUpdate = jest.fn();
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      category: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'A',
          type: 'genre',
          slug: 'a',
          parentId: null,
        }),
        findFirst: jest.fn().mockResolvedValue({ id: 'other' }),
        update: txUpdate,
      },
    };
    prisma.$transaction = jest
      .fn()
      .mockImplementation((cb: (client: unknown) => unknown) => cb(tx));

    await expect(service.update('A', { slug: 'taken' })).rejects.toThrow(
      'Category with same slug already exists',
    );
    expect(txUpdate).not.toHaveBeenCalled();
    // Счётчик обязателен рядом с `toHaveBeenCalledWith` (`L-005`): через тот же
    // `tx.category.findFirst` ходит `assertChildTypesAllowed`, и совпадение
    // по аргументам засчиталось бы по любому из вызовов.
    expect(tx.category.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.category.findFirst).toHaveBeenCalledWith({
      where: { slug: 'taken', NOT: { id: 'A' } },
      select: { id: true },
    });
  });

  /**
   * 🔴 `LEGACY-276`, сама гонка. `PATCH {"slug"}` дерева не касается и идёт
   * через `runInTree`, то есть мимо очереди дерева. Пока замка по слагу
   * не было, пара «проверил — записал» не была сериализована ничем: на
   * READ COMMITTED соседний писатель того же слага не виден до своего коммита,
   * а уникального индекса в базе нет до релиза 2 — оба запроса проходили.
   *
   * ⚠️ Проверяется **порядок**: замок, взятый после проверки, не стережёт
   * ничего (`LEGACY-310`). И проверяется, что это замок именно слага, а не
   * дерева: подмена одного другим вернула бы `P2028` на переименовании
   * во время импорта (`LEGACY-256`).
   */
  it('PATCH одного слага берёт замок слага первым оператором, а замок дерева не берёт (LEGACY-276)', async () => {
    const order: string[] = [];
    prisma.category.findUnique.mockResolvedValue({
      id: 'A',
      type: 'genre',
      slug: 'a-old',
      parentId: null,
      key: 'a',
    });
    prisma.category.findFirst.mockResolvedValue(null);

    const tx = {
      $queryRaw: jest.fn((parts?: { raw?: readonly string[] }) => {
        const sql = (parts?.raw ?? []).join(' ');
        order.push(sql.includes('hashtext') ? 'lock-slug' : 'lock-tree');
        return Promise.resolve([]);
      }),
      category: {
        findUnique: jest.fn(() => {
          order.push('read');
          return Promise.resolve({ id: 'A', type: 'genre', slug: 'a-old', parentId: null });
        }),
        findFirst: jest.fn(() => {
          order.push('slug-check');
          return Promise.resolve(null);
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

    await service.update('A', { slug: 'a-new' });

    expect(order[0]).toBe('lock-slug');
    expect(order).not.toContain('lock-tree');
    expect(order.indexOf('lock-slug')).toBeLessThan(order.indexOf('slug-check'));
    expect(order.indexOf('slug-check')).toBeLessThan(order.indexOf('write'));
    // Ключ замка — слаг из тела запроса, а не из строки базы: иначе замок
    // берётся по адресу, который освобождают, а не по тому, который занимают.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(slugLockValues(tx.$queryRaw)).toContain('a-new');
  });

  /**
   * 🔴 `LEGACY-276`, обратная сторона. `PATCH`, слага не несущий, писателем
   * слага не является: замок он брать не должен вовсе, иначе переименование
   * без смены адреса встаёт в чужую очередь просто так.
   */
  it('PATCH без слага замка слага не берёт (LEGACY-276)', async () => {
    const order: string[] = [];
    prisma.category.findUnique.mockResolvedValue({
      id: 'A',
      type: 'genre',
      slug: 'a',
      parentId: null,
      key: 'a',
    });

    const tx = {
      $queryRaw: jest.fn((parts?: { raw?: readonly string[] }) => {
        const sql = (parts?.raw ?? []).join(' ');
        order.push(sql.includes('hashtext') ? 'lock-slug' : 'lock-tree');
        return Promise.resolve([]);
      }),
      category: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'A',
          type: 'genre',
          slug: 'a',
          parentId: null,
        }),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(() => {
          order.push('write');
          return Promise.resolve({ id: 'A' });
        }),
      },
    };
    prisma.$transaction = jest
      .fn()
      .mockImplementation((cb: (client: unknown) => unknown) => cb(tx));

    await service.update('A', { name: 'Renamed' });

    expect(order).toEqual(['write']);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  /**
   * `LEGACY-276`. До этой правки финальная запись `update` не ловила `P2002`
   * вовсе: гонка на слаге, прошедшая мимо `assertSlugFree` этой же
   * транзакции (сегодня — окно до появления `@@unique([slug])`, до тех пор
   * это соглашение кода, а не ограничение базы), отвечала бы 500, а не 400.
   * `create` через `writeCategoryRow` ловит с `LEGACY-311`, у `update` копии
   * не было.
   */
  it('update отвечает 400, а не падает 500, если запись столкнулась с занятым слагом (LEGACY-276)', async () => {
    prisma.category.findUnique.mockResolvedValue({
      id: 'A',
      type: 'genre',
      slug: 'a',
      parentId: null,
      key: 'a',
    });
    const conflict = Object.assign(new Error('unique'), {
      code: 'P2002',
      meta: { target: ['slug'] },
    });
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      category: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'A',
          type: 'genre',
          slug: 'a',
          parentId: null,
        }),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockRejectedValue(conflict),
      },
    };
    prisma.$transaction = jest
      .fn()
      .mockImplementation((cb: (client: unknown) => unknown) => cb(tx));

    // Тип, а не только текст (`L-004`): `toThrow(string)` зеленеет на любом
    // `Error`, и возврат `writeCategoryRow` к голому `throw new Error(...)`
    // вернул бы 500, оставив проверку зелёной.
    const rejection = service.update('A', { slug: 'taken' });
    await expect(rejection).rejects.toBeInstanceOf(BadRequestException);
    await expect(rejection).rejects.toThrow('Category with same slug already exists');
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
        findFirst: jest.fn(() => {
          order.push('tx.category.findFirst');
          return Promise.resolve(null);
        }),
        count: jest.fn(() => {
          order.push('tx.count');
          return Promise.resolve(0);
        }),
        delete: jest.fn(() => {
          order.push('tx.category.delete');
          return Promise.resolve({ id: 'A', slug: 'a' });
        }),
      },
      bookCategory: {
        deleteMany: jest.fn(() => {
          order.push('tx.bookCategory.deleteMany');
          return Promise.resolve({ count: 0 });
        }),
      },
      categoryTranslation: {
        findMany: jest.fn(() => {
          order.push('tx.categoryTranslation.findMany');
          return Promise.resolve([]);
        }),
        deleteMany: jest.fn(() => {
          order.push('tx.categoryTranslation.deleteMany');
          return Promise.resolve({ count: 0 });
        }),
      },
      slugRedirect: {
        deleteMany: jest.fn(() => {
          order.push('tx.slugRedirect.deleteMany');
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

    await service.remove('A', 'admin-actor-1');

    expect(order).toEqual([
      'lock',
      'tx.read',
      'tx.count',
      // `LEGACY-390`: умирающие адреса читаются ДО удаления — после `deleteMany`
      // взять их уже неоткуда.
      'tx.categoryTranslation.findMany',
      'tx.bookCategory.deleteMany',
      'tx.categoryTranslation.deleteMany',
      'tx.category.delete',
      // Судьба записей, ведущих на исчезнувший базовый слаг, решается после удаления:
      // до него слаг ещё живой и уборка была бы неверной.
      'tx.category.findFirst',
      // `LEGACY-394`: живость спрашивается по языкам, поэтому второй запрос —
      // `findMany` за языками живых переводов, а уборка идёт одним `deleteMany`
      // с перечнем мёртвых языков, попадающим в `@@index([entityType, language, newSlug])`.
      'tx.categoryTranslation.findMany',
      'tx.slugRedirect.deleteMany',
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
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockRejectedValue(new Error('db is down')),
      },
    };
    prisma.$transaction = jest
      .fn()
      .mockImplementation((cb: (client: unknown) => unknown) => cb(tx));

    await expect(service.remove('A', 'admin-actor-1')).rejects.toThrow('db is down');
    expect(tx.category.delete).not.toHaveBeenCalled();
  });

  it('remove rejects when category has children', async () => {
    prisma.category.findUnique.mockResolvedValue({ id: 'A' });
    prisma.category.count.mockResolvedValue(1);
    await expect(service.remove('A', 'admin-actor-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  /**
   * `LEGACY-390`, утверждающие тесты. До 15.09.2026 политика владельца («адрес термина
   * уходит на родителя, а не в 404») жила в одном из двух путей смерти адреса:
   * `deleteTranslation` редирект писал, а `remove()` сносил переводы по всем языкам
   * и не писал ничего. Админ удалял листовую категорию — до пяти языковых адресов
   * уходили в 404 при живом родителе.
   *
   * Случаи ниже покрывают обе половины политики и её отличие от `deleteTranslation`:
   * «пишется на каждый язык», «не пишется, когда адрес остался живым у чужой категории»
   * и «своя собственная строка из проверки исключена» — последнее и есть то, чем эти
   * два пути обязаны различаться (решение арбитра 15.09.2026).
   */
  const arrangeRemove = (
    dying: { language: Language; slug: string }[],
    parentTranslations: { language: Language; slug: string }[] | null,
    /**
     * Языки, в которых базовый слаг удалённой категории (`fiction`) носит **чужой**
     * живой перевод. По умолчанию таких нет: слаг мёртв во всех пяти языках, и записи,
     * ведущие на него, подлежат уборке целиком (`LEGACY-394`).
     */
    baseSlugAliveIn: Language[] = [],
    /**
     * Чужие живые категории, чей базовый `Category.slug` совпадает с проверяемым.
     * `dyingSlug` — про слаг умирающего перевода (`roman`), его спрашивает ветка 1
     * `retireCategoryAddress`; `baseSlug` — про базовый слаг удалённой категории
     * (`fiction`), его спрашивает `deadLanguagesForSlug`. Две разные проверки,
     * и мок обязан различать их, иначе поломка одной маскируется ответом другой.
     *
     * 🔴 `LEGACY-276`, релиз 2: вариант `baseSlug` остаётся нужным и после
     * `@@unique([slug])`. Он описывает состояние «дубли есть, миграция упала,
     * образ поднялся» — энтрипойнт глотает отказ `migrate deploy` (`ADR-018`,
     * раздел «Цена»), а падает он ровно на дублях. Разбор — в докблоке
     * `CategoryService.deadLanguagesForSlug`.
     */
    takenBy: { dyingSlug?: { id: string }; baseSlug?: { id: string } } = {},
  ) => {
    const { dyingSlug: dyingSlugTakenBy = null, baseSlug: baseSlugTakenBy = null } = takenBy;
    prisma.category.findUnique.mockResolvedValue({
      id: 'cat1',
      parent: parentTranslations === null ? null : { translations: parentTranslations },
    });
    prisma.category.count.mockResolvedValue(0);
    // `findMany` зовётся дважды и за разным: сперва за умирающими адресами самой
    // категории (`where.categoryId`), потом за языками живых носителей базового слага
    // (`where.slug`). Один `mockResolvedValue` на оба вызова вернул бы умирающие
    // адреса в ответ на вопрос о живых — и уборка молча пропала бы.
    //
    // Третья форма отвечает отказом, а не данными: молчаливый фоллбэк на ответ
    // о живости скормил бы будущему запросу чужие строки и оставил проверку зелёной.
    prisma.categoryTranslation.findMany.mockImplementation(
      (args?: { where?: { categoryId?: string; slug?: string } }) => {
        if (args?.where?.categoryId) return Promise.resolve(dying);
        if (args?.where?.slug) {
          return Promise.resolve(baseSlugAliveIn.map((language) => ({ language })));
        }
        throw new Error(
          `categoryTranslation.findMany: мок не настроен на ${JSON.stringify(args?.where)}`,
        );
      },
    );
    prisma.bookCategory.deleteMany.mockResolvedValue({ count: 0 });
    prisma.categoryTranslation.deleteMany.mockResolvedValue({ count: dying.length });
    prisma.category.delete.mockResolvedValue({ id: 'cat1', slug: 'fiction' });
    prisma.slugRedirect.deleteMany.mockResolvedValue({ count: 0 });
    // 🔴 `category.findFirst` стоит на двух независимых местах: ветка 1
    // `retireCategoryAddress` спрашивает про слаг умирающего ПЕРЕВОДА (с `id: { not }`),
    // `deadLanguagesForSlug` — про БАЗОВЫЙ слаг удалённой категории (без исключения).
    // Один `mockResolvedValue` на оба означал бы, что поломка второго маскируется
    // ответом, предназначенным первому, и тест проходит по неверной причине.
    prisma.category.findFirst.mockImplementation((args?: { where?: { id?: unknown } }) =>
      Promise.resolve(args?.where?.id ? dyingSlugTakenBy : baseSlugTakenBy),
    );
  };

  /**
   * Сколько раз `slugRedirect.deleteMany` обязан быть позван за один `remove()`,
   * когда базовый слаг никем не занят: по вызову на каждый умирающий перевод плюс
   * ровно один на всю уборку базового слага — она идёт одним запросом
   * с `language: { in: [...] }`, а не пятью (`LEGACY-394`).
   */
  const cleanupCalls = (dyingCount: number) => dyingCount + 1;

  it('LEGACY-390: удаление категории уводит на родителя каждый язык, а не только первый', async () => {
    arrangeRemove(
      [
        { language: Language.ru, slug: 'roman' },
        { language: Language.en, slug: 'novel' },
      ],
      [
        { language: Language.ru, slug: 'hudozhestvennaya-literatura' },
        // ⚠️ Слаг нарочно не равен базовому слагу удаляемой категории (`fiction`).
        // Равенство делало бы стенд невозможным: живой en-перевод родителя с этим
        // слагом нашёл бы `deadLanguagesForSlug`, и `en` выпал бы из мёртвых языков,
        // а мок `baseSlugAliveIn` по умолчанию утверждает обратное — что слаг
        // не занят никем (находка ревью 22.09.2026).
        { language: Language.en, slug: 'fiction-genre' },
      ],
    );

    await service.remove('cat1', 'admin-actor-1');

    // Четыре записи, а не две: по одной на каждый умерший перевод плюс по одной
    // с базового слага на тот же язык (`LEGACY-392`). Базовый слаг был адресом
    // во всех пяти языках через фоллбэк, но 308 получают только те, где у родителя
    // есть перевод, — здесь это `ru` и `en`.
    expect(slugRedirects.record).toHaveBeenCalledTimes(4);
    expect(slugRedirects.record).toHaveBeenCalledWith(
      {
        entityType: 'category',
        language: Language.ru,
        oldSlug: 'roman',
        newSlug: 'hudozhestvennaya-literatura',
      },
      expect.anything(),
    );
    expect(slugRedirects.record).toHaveBeenCalledWith(
      { entityType: 'category', language: Language.en, oldSlug: 'novel', newSlug: 'fiction-genre' },
      expect.anything(),
    );
    // Счётчик выше держится на этих двух: без них четвёрка не говорит, какие
    // именно записи пришли с базового слага.
    expect(slugRedirects.record).toHaveBeenCalledWith(
      {
        entityType: 'category',
        language: Language.ru,
        oldSlug: 'fiction',
        newSlug: 'hudozhestvennaya-literatura',
      },
      expect.anything(),
    );
    expect(slugRedirects.record).toHaveBeenCalledWith(
      {
        entityType: 'category',
        language: Language.en,
        oldSlug: 'fiction',
        newSlug: 'fiction-genre',
      },
      expect.anything(),
    );
  });

  /**
   * 🔴 Отличие от `deleteTranslation`, ради которого заведён отдельный кейс.
   * Там категория остаётся жить, и слаг, равный её базовому `Category.slug`,
   * продолжает отвечать 200 через фоллбэк `getByLangSlugWithBooks` — редиректа
   * он не получает. Здесь строка категории исчезает, фоллбэка нет, адрес мёртв:
   * из проверки исключается только ЧУЖАЯ живая категория. Проверяется форма
   * запроса, потому что иначе «свой» слаг молча терял бы 308.
   */
  it('LEGACY-390: собственный базовый слаг из проверки исключён — редирект выдаётся', async () => {
    arrangeRemove(
      [{ language: Language.ru, slug: 'roman' }],
      [{ language: Language.ru, slug: 'hudozhestvennaya-literatura' }],
    );

    await service.remove('cat1', 'admin-actor-1');

    // Два вызова: отбор занятости исчезающего слага перевода и проверка того,
    // жив ли ещё базовый слаг удалённой категории.
    expect(prisma.category.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.category.findFirst).toHaveBeenCalledWith({
      where: { slug: 'roman', id: { not: 'cat1' } },
      select: { id: true },
    });
    // Два: слаг умершего перевода и базовый слаг той же категории (`LEGACY-392`),
    // оба уводят на ru-перевод родителя.
    expect(slugRedirects.record).toHaveBeenCalledTimes(2);
  });

  it('LEGACY-390: слаг перевода, занятый живой чужой категорией, редиректа не получает', async () => {
    arrangeRemove(
      [{ language: Language.ru, slug: 'roman' }],
      [{ language: Language.ru, slug: 'hudozhestvennaya-literatura' }],
      [],
      // Тот же слаг — базовый у другой, остающейся жить категории: публичный резолв
      // ответит по ней 200, и 308 не дошёл бы до посетителя никогда.
      { dyingSlug: { id: 'other' } },
    );

    await service.remove('cat1', 'admin-actor-1');

    // Живым остался только слаг умершего ПЕРЕВОДА — он редиректа не получает.
    // Базовый слаг категории умер вместе с ней и 308 получает (`LEGACY-392`):
    // это два разных адреса, и живость у каждого своя.
    expect(slugRedirects.record).toHaveBeenCalledTimes(1);
    expect(slugRedirects.record).toHaveBeenCalledWith(
      expect.objectContaining({ oldSlug: 'fiction' }),
      expect.anything(),
    );
    expect(slugRedirects.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ oldSlug: 'roman' }),
      expect.anything(),
    );
  });

  it('LEGACY-390: записи, ведущие на исчезающие слаги, снимаются по каждому языку', async () => {
    arrangeRemove(
      [
        { language: Language.ru, slug: 'roman' },
        { language: Language.en, slug: 'novel' },
      ],
      [{ language: Language.ru, slug: 'hudozhestvennaya-literatura' }],
    );

    await service.remove('cat1', 'admin-actor-1');

    // Иначе адрес, который вёл сюда 308-м, после исчезновения цели указывал бы в 404.
    // Счётчик обязателен рядом с `toHaveBeenCalledWith` (`L-005`): без него уборка,
    // расширенная до `deleteMany({ entityType, language })` без `newSlug`, снесла бы
    // историю всех категорий языка и оставила обе проверки зелёными.
    expect(prisma.slugRedirect.deleteMany).toHaveBeenCalledTimes(cleanupCalls(2));
    expect(prisma.slugRedirect.deleteMany).toHaveBeenCalledWith({
      where: { entityType: 'category', language: Language.ru, newSlug: 'roman' },
    });
    expect(prisma.slugRedirect.deleteMany).toHaveBeenCalledWith({
      where: { entityType: 'category', language: Language.en, newSlug: 'novel' },
    });
    // Последний вызов — записи, ведущие на исчезнувший БАЗОВЫЙ слаг: их пишет
    // `recordBaseSlugChange` сразу на пять языков, и снимаются они одним запросом
    // с перечнем мёртвых языков — тот же индекс, один round-trip (`LEGACY-394`).
    expect(prisma.slugRedirect.deleteMany).toHaveBeenCalledWith({
      where: {
        entityType: 'category',
        language: { in: Object.values(Language) },
        newSlug: 'fiction',
      },
    });
  });

  it('LEGACY-390: язык, которого нет у родителя, остаётся 404 — остальные уводятся', async () => {
    arrangeRemove(
      [
        { language: Language.ru, slug: 'roman' },
        { language: Language.en, slug: 'novel' },
      ],
      // У родителя переведён только `ru`.
      [{ language: Language.ru, slug: 'hudozhestvennaya-literatura' }],
    );

    await service.remove('cat1', 'admin-actor-1');

    // Два: умерший ru-перевод и базовый слаг в том же `ru` (`LEGACY-392`).
    // `en` не получает ни того, ни другого — у родителя нет en-перевода,
    // и достраивать адресата за него нельзя (D1).
    expect(slugRedirects.record).toHaveBeenCalledTimes(2);
    expect(slugRedirects.record).toHaveBeenCalledWith(
      expect.objectContaining({ language: Language.ru }),
      expect.anything(),
    );
    expect(slugRedirects.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ language: Language.en }),
      expect.anything(),
    );
    // Уборка идёт по каждому языку независимо от того, нашёлся ли преемник,
    // плюс один запрос на базовый слаг.
    expect(prisma.slugRedirect.deleteMany).toHaveBeenCalledTimes(cleanupCalls(2));
  });

  /**
   * 🔴 Порядок, а не оформление. `SlugRedirectService.record` переписывает цепочки
   * (`updateMany` по `newSlug = oldSlug`), поэтому прежние адреса того же термина
   * уезжают на нового преемника сами — но только если `record` идёт ДО уборки.
   * При обратном порядке уборка сносит их раньше: слаг, переименованный до удаления,
   * отвечает 404 вместо 308, а выданный когда-то 308 из индекса не отзывается.
   */
  it('LEGACY-390: преемник записывается до уборки — цепочка прежних слагов уцелевает', async () => {
    const order: string[] = [];
    arrangeRemove(
      [{ language: Language.ru, slug: 'roman' }],
      [{ language: Language.ru, slug: 'hudozhestvennaya-literatura' }],
    );
    slugRedirects.record.mockImplementation(() => {
      order.push('record');
      return Promise.resolve(undefined);
    });
    prisma.slugRedirect.deleteMany.mockImplementation(() => {
      order.push('deleteMany');
      return Promise.resolve({ count: 0 });
    });

    await service.remove('cat1', 'admin-actor-1');

    expect(order[0]).toBe('record');
    expect(order).toContain('deleteMany');
  });

  /**
   * Обратная половина уборки базового слага: слаг, который держит живой перевод,
   * продолжает резолвиться публично, и 308 на него — верный. Снести такие записи
   * значило бы превратить рабочий редирект в 404.
   */
  it('LEGACY-390: базовый слаг, живой в одном языке, записи этого языка сохраняет', async () => {
    // Тот же базовый слаг носит en-перевод другой, остающейся жить категории.
    arrangeRemove([{ language: Language.ru, slug: 'roman' }], null, [Language.en]);

    await service.remove('cat1', 'admin-actor-1');

    // Счётчик первым (`L-005`): без него разбор по `mock.calls` брал бы первый
    // подходящий вызов и молчал про остальные — вернувшийся цикл по языкам
    // остался бы незамеченным.
    expect(prisma.slugRedirect.deleteMany).toHaveBeenCalledTimes(cleanupCalls(1));
    // `en` жив, поэтому в перечне мёртвых языков его быть не может, а остальные
    // четыре обязаны быть: пустой `in: []` проверку проходить не должен.
    expect(prisma.slugRedirect.deleteMany).toHaveBeenCalledWith({
      where: {
        entityType: 'category',
        language: { in: [Language.es, Language.fr, Language.pt, Language.ru] },
        newSlug: 'fiction',
      },
    });
  });

  /**
   * Нулевая уборка: базовый слаг жив **во всех** языках, потому что его носят чужие
   * переводы на каждом. Тогда `deadLanguagesForSlug` возвращает пустой список,
   * и запроса на базовый слаг не делается вовсе — снести эти записи значило бы
   * выдать 404 по индексированному адресу, который отвечает 200.
   *
   * ⚠️ Ветка отличается от соседней «слаг занят чужой живой категорией»: там пустой
   * список даёт ранний выход по `isBaseSlugTaken`, здесь — отбор языков после него.
   */
  it('LEGACY-394: базовый слаг, живой во всех языках, уборки не получает вовсе', async () => {
    arrangeRemove([{ language: Language.ru, slug: 'roman' }], null, Object.values(Language));

    await service.remove('cat1', 'admin-actor-1');

    // Остался ровно один вызов — на умерший ru-перевод; базовый слаг не тронут.
    expect(prisma.slugRedirect.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.slugRedirect.deleteMany).toHaveBeenCalledWith({
      where: { entityType: 'category', language: Language.ru, newSlug: 'roman' },
    });
  });

  /**
   * 🔴 Посадка `LEGACY-394` — дефекта, внесённого правкой `LEGACY-390` и уехавшего
   * на прод в `v1.0.77`.
   *
   * Прежний хелпер спрашивал `categoryTranslation.findFirst({ slug })` **без отбора
   * по языку**: один чужой en-перевод со слагом `fiction` объявлял адрес живым
   * во всех пяти языках, уборка не выполнялась вовсе, и строки `… → fiction`
   * в `ru`, `es`, `fr`, `pt` оставались 308-м на адрес, который отвечает 404.
   *
   * Публичный резолв языка не путает: `getByLangSlugWithBooks` ищет пару
   * `language_slug` и лишь при промахе падает на базовый `Category.slug`. Чужой
   * en-перевод оживляет `/en/...` — и только его.
   *
   * ⚠️ Кейс краснеет от возврата дефекта: с ответом «жив во всех языках» ни одного
   * вызова уборки не будет, и первое же `toHaveBeenCalledWith` не найдёт своего.
   */
  it('LEGACY-394: чужой перевод оживляет базовый слаг только в своём языке', async () => {
    arrangeRemove(
      [{ language: Language.ru, slug: 'roman' }],
      [{ language: Language.ru, slug: 'hudozhestvennaya-literatura' }],
      [Language.en],
    );

    await service.remove('cat1', 'admin-actor-1');

    // Живой только `en` — уборку обязаны получить ровно остальные четыре языка,
    // и `en` в перечне стоять не должен.
    expect(prisma.slugRedirect.deleteMany).toHaveBeenCalledWith({
      where: {
        entityType: 'category',
        language: { in: [Language.es, Language.fr, Language.pt, Language.ru] },
        newSlug: 'fiction',
      },
    });
    // Счётчик стоит рядом с проверкой формы не для красоты (`L-005`): без него
    // уборка, снявшая заодно и `en`, осталась бы незамеченной.
    expect(prisma.slugRedirect.deleteMany).toHaveBeenCalledTimes(cleanupCalls(1));
  });

  /**
   * Вторая половина `LEGACY-394`: форма запроса уборки. Отбор по языку — не деталь
   * оформления, а попадание в `@@index([entityType, language, newSlug])`. Без языка
   * ведущим столбцом остаётся `entityType`, у всех строк равный `'category'`,
   * и запрос сканирует историю слагов целиком — внутри транзакции, которая держит
   * глобальный advisory-замок дерева категорий.
   */
  it('LEGACY-394: уборка базового слага идёт с языком — запрос попадает в индекс', async () => {
    arrangeRemove([{ language: Language.ru, slug: 'roman' }], null);

    await service.remove('cat1', 'admin-actor-1');

    // 🔴 Счётчик первым: без него кейс зеленеет на пустом списке вызовов, то есть
    // ровно в том исходе, ради запрета которого запись и заведена (`L-015` —
    // проверка обязана уметь сказать «я не проверила»).
    expect(prisma.slugRedirect.deleteMany).toHaveBeenCalledTimes(cleanupCalls(1));
    for (const call of prisma.slugRedirect.deleteMany.mock.calls) {
      expect(call[0].where).toHaveProperty('language');
    }
  });

  /**
   * 🔴 Ветка живого адреса на пути удаления категории целиком. Слаг держит базовый
   * `Category.slug` чужой живой категории, значит публичный резолв по нему по-прежнему
   * отвечает 200 через фоллбэк. Записи, которые вели сюда 308-м, ведут на работающую
   * страницу — снести их значит выдать 404 по индексированному адресу, а он
   * не отзывается (решение арбитра 15.09.2026).
   *
   * 🔴 `LEGACY-276`, релиз 2: кейс остаётся нужным и после `@@unique([slug])`.
   * С живым индексом двух категорий на одном базовом слаге не бывает — но индекс
   * может отсутствовать при живом новом образе: `scripts/docker-entrypoint.sh`
   * глотает отказ `prisma migrate deploy` (`ADR-018`, «Цена»), а падает он ровно
   * на дублях (`23505`). Этот кейс — единственная проверка того, что в таком
   * состоянии уборка не сносит записи, ведущие на живой адрес.
   */
  it('LEGACY-390: при живом чужом базовом слаге записи на него не снимаются', async () => {
    arrangeRemove(
      [{ language: Language.ru, slug: 'roman' }],
      [{ language: Language.ru, slug: 'hudozhestvennaya-literatura' }],
      [],
      // Слаг занят чужой живой категорией на обеих проверках: и как слаг умирающего
      // перевода, и как базовый слаг удалённой категории. Оба адреса живы, значит
      // не пишется ни редиректа, ни уборки.
      { dyingSlug: { id: 'other' }, baseSlug: { id: 'other' } },
    );

    await service.remove('cat1', 'admin-actor-1');

    expect(slugRedirects.record).not.toHaveBeenCalled();
    expect(prisma.slugRedirect.deleteMany).not.toHaveBeenCalled();
  });

  /**
   * 🔴 Посадка `LEGACY-392`. Базовый `Category.slug` был **вторым** публичным адресом
   * каждого перевода: резолв ищет пару `language_slug`, а при промахе падает
   * на `Category.slug` (`getByLangSlugWithBooks`) и отдаёт страницу запрошенного
   * языка. После удаления категории строка исчезает, фоллбэк не срабатывает —
   * и адрес отвечает 404 даже там, где родитель жив. До этой правки 308 с базового
   * слага не писался вовсе: редиректы получали только слаги переводов.
   *
   * Форма — один переход, прямо на перевод родителя того же языка (решение арбитра
   * 22.09.2026, вариант A). Кейс краснеет от возврата дефекта: сними запись — и ни
   * одного вызова с `oldSlug: 'fiction'` не останется.
   */
  it('LEGACY-392: базовый слаг удалённой категории уводит на перевод родителя того же языка', async () => {
    arrangeRemove(
      // Переводы на двух языках — значит и базовый слаг был адресом на двух,
      // и 308 обязан прийти на оба.
      [
        { language: Language.ru, slug: 'roman' },
        { language: Language.es, slug: 'novela' },
      ],
      [
        { language: Language.ru, slug: 'hudozhestvennaya-literatura' },
        { language: Language.es, slug: 'ficcion' },
      ],
    );

    await service.remove('cat1', 'admin-actor-1');

    // Четыре записи: два умерших перевода плюс базовый слаг в `ru` и в `es` —
    // ровно в тех языках, где у категории был перевод, а у родителя он есть.
    expect(slugRedirects.record).toHaveBeenCalledTimes(4);
    expect(slugRedirects.record).toHaveBeenCalledWith(
      {
        entityType: 'category',
        language: Language.ru,
        oldSlug: 'fiction',
        newSlug: 'hudozhestvennaya-literatura',
      },
      expect.anything(),
    );
    expect(slugRedirects.record).toHaveBeenCalledWith(
      { entityType: 'category', language: Language.es, oldSlug: 'fiction', newSlug: 'ficcion' },
      expect.anything(),
    );
    // 🔴 Адресат — перевод родителя, а не его базовый слаг: второй вариант дал бы
    // либо два перехода, либо 308 в 404 там, где перевода у родителя нет.
    // `recordBaseSlugChange` пишет именно на базовый слаг, поэтому его здесь быть
    // не должно вовсе.
    expect(slugRedirects.recordBaseSlugChange).not.toHaveBeenCalled();
  });

  /**
   * Вторая половина D1 для базового слага: адресата за родителя не достраивают.
   * Нет перевода на этот язык — остаётся 404, потому что невыданный 308 чинится
   * вторым заходом, а выданный из поискового индекса не отзывается.
   */
  it('LEGACY-392: язык без перевода у родителя 308 с базового слага не получает', async () => {
    arrangeRemove(
      [{ language: Language.ru, slug: 'roman' }],
      // У родителя переведён только `ru` — остальные четыре языка остаются 404.
      [{ language: Language.ru, slug: 'hudozhestvennaya-literatura' }],
    );

    await service.remove('cat1', 'admin-actor-1');

    const baseSlugCalls = slugRedirects.record.mock.calls.filter(
      (call) => (call[0] as { oldSlug: string }).oldSlug === 'fiction',
    );
    expect(baseSlugCalls).toHaveLength(1);
    expect(baseSlugCalls[0][0]).toEqual({
      entityType: 'category',
      language: Language.ru,
      oldSlug: 'fiction',
      newSlug: 'hudozhestvennaya-literatura',
    });
  });

  /**
   * 🔴 Язык, в котором базовый слаг остался живым, 308 не получает вовсе. Живость
   * здесь даёт чужой перевод с тем же слагом: публичный резолв находит пару
   * `language_slug` раньше, чем доходит до фоллбэка, и отвечает 200 чужой страницей.
   * Редирект в этом языке увёл бы посетителя с работающего адреса.
   *
   * Множество берётся у `deadLanguagesForSlug` — того же, по которому идёт уборка.
   * Возьми запись множество шире (например, все языки подряд), кейс краснеет.
   */
  it('LEGACY-392: язык, где базовый слаг жив чужим переводом, редиректа не получает', async () => {
    arrangeRemove(
      [{ language: Language.ru, slug: 'roman' }],
      [
        { language: Language.ru, slug: 'hudozhestvennaya-literatura' },
        { language: Language.en, slug: 'literature' },
      ],
      // Тот же `fiction` носит en-перевод другой, остающейся жить категории.
      [Language.en],
    );

    await service.remove('cat1', 'admin-actor-1');

    // 🔴 Счётчик рядом с обеими проверками (`L-005`): `toHaveBeenCalledWith` матчит
    // по любому вызову из всех, поэтому без него лишняя запись — на `es`, `fr`, `pt`
    // или вторая на тот же `ru` — осталась бы незамеченной. Ровно два: умерший
    // ru-перевод и базовый слаг в `ru`.
    expect(slugRedirects.record).toHaveBeenCalledTimes(2);
    expect(slugRedirects.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ language: Language.en, oldSlug: 'fiction' }),
      expect.anything(),
    );
    expect(slugRedirects.record).toHaveBeenCalledWith(
      expect.objectContaining({ language: Language.ru, oldSlug: 'fiction' }),
      expect.anything(),
    );
  });

  /**
   * 🔴 Посадка на дубль, найденный ревью 22.09.2026. Базовый слаг категории равен
   * слагу её же ru-перевода — так термины заводит сид, случай рядовой. Адрес тогда
   * один, а не два, и обслужить его обязан ровно один вызов: цикл по умершим
   * переводам. Без пропуска новый цикл звал бы `record` второй раз с теми же
   * аргументами — данных это не меняет (`upsert`), но стоит три лишних обмена
   * внутри транзакции, держащей глобальный advisory-замок дерева.
   */
  it('LEGACY-392: слаг перевода, равный базовому, обслуживается одним вызовом, а не двумя', async () => {
    arrangeRemove(
      // Слаг умершего ru-перевода совпадает с базовым слагом категории (`fiction`).
      [{ language: Language.ru, slug: 'fiction' }],
      [{ language: Language.ru, slug: 'hudozhestvennaya-literatura' }],
    );

    await service.remove('cat1', 'admin-actor-1');

    expect(slugRedirects.record).toHaveBeenCalledTimes(1);
    expect(slugRedirects.record).toHaveBeenCalledWith(
      {
        entityType: 'category',
        language: Language.ru,
        oldSlug: 'fiction',
        newSlug: 'hudozhestvennaya-literatura',
      },
      expect.anything(),
    );
  });

  /**
   * 🔴 Посадка на сужение множества языков (решение арбитра 22.09.2026 по находке
   * ревью). Базовый слаг был живым адресом **только там, где у категории был
   * перевод**: без перевода резолв отдаёт 200 с `translation: null`, а фронт уходит
   * в `notFound()` до истории слагов, то есть адрес отвечал 404 и до удаления.
   * 308 на таком языке был бы не возвратом умершего адреса, а заведением нового —
   * а он из поискового индекса не отзывается.
   *
   * Кейс краснеет от возврата дефекта: верни цикл на `deadLanguages` целиком —
   * и `es`, `fr`, `pt` получат по записи, хотя перевода у категории там не было
   * никогда.
   */
  it('LEGACY-392: язык без перевода у категории 308 не получает — адрес был 404 и до удаления', async () => {
    arrangeRemove(
      // У категории перевод только на `ru`.
      [{ language: Language.ru, slug: 'roman' }],
      // У родителя переводы на всех пяти — преемник есть везде, и только
      // множество языков решает, куда пишется 308.
      Object.values(Language).map((language) => ({ language, slug: `parent-${language}` })),
    );

    await service.remove('cat1', 'admin-actor-1');

    const baseSlugLanguages = slugRedirects.record.mock.calls
      .filter((call) => (call[0] as { oldSlug: string }).oldSlug === 'fiction')
      .map((call) => (call[0] as { language: Language }).language);
    // Ровно один язык — тот, где у категории был перевод. Не пять.
    expect(baseSlugLanguages).toEqual([Language.ru]);
    // Уборка при этом идёт по всем мёртвым языкам: множества намеренно разные,
    // потому что отвечают на разные вопросы. Счётчик обязателен рядом (`L-005`):
    // именно этот кейс объявлен сторожем расхождения, и без него возврат уборки
    // в цикл по языкам — пять запросов вместо одного (`LEGACY-394`) — остался бы
    // незамеченным: батчевый вызов матчер нашёл бы среди прочих.
    expect(prisma.slugRedirect.deleteMany).toHaveBeenCalledTimes(cleanupCalls(1));
    expect(prisma.slugRedirect.deleteMany).toHaveBeenCalledWith({
      where: {
        entityType: 'category',
        language: { in: Object.values(Language) },
        newSlug: 'fiction',
      },
    });
  });

  /**
   * 🔴 Посадка проверки живости **по языку** в новом цикле (находка ревью 22.09.2026).
   * Соседний кейс «при живом чужом базовом слаге записи не снимаются» ловит снятие
   * этой строки, но по другой причине — там слаг занят чужой живой **категорией**,
   * и `deadLanguagesForSlug` выходит рано с пустым списком. Здесь список не пуст:
   * слаг жив только в `en`, и только поязыковая проверка мешает записи.
   *
   * Сценарий из прода, а не выдуманный. Категория `A`: базовый слаг `fiction`,
   * переводы `ru` и `en`. Категория `B` остаётся жить и держит **en-перевод**
   * со слагом `fiction` — `@@unique([language, slug])` это разрешает, базовый слаг
   * у `B` свой. Удаление `A` без этой проверки зовёт `record(en, fiction → …)`,
   * а он делает `updateMany where newSlug = 'fiction'`: все строки истории, ведущие
   * сегодня 308-м на живую страницу `B` в `en`, переезжают на родителя `A`, и сверх
   * того заводится 308 с адреса, который отвечает 200. Это ровно тот урон
   * `LEGACY-394`, что уехал в прод в `v1.0.77`, — возвращённый через новый путь записи.
   */
  it('LEGACY-392: язык, где базовый слаг жив чужим переводом, 308 не получает даже при своём переводе', async () => {
    arrangeRemove(
      // У категории переводы на обоих языках — значит оба попадают в перебор.
      [
        { language: Language.ru, slug: 'roman' },
        { language: Language.en, slug: 'novel' },
      ],
      // У родителя переводы тоже на обоих — преемник доступен везде.
      [
        { language: Language.ru, slug: 'hudozhestvennaya-literatura' },
        { language: Language.en, slug: 'literature' },
      ],
      // 🔴 Базовый слаг `fiction` жив в `en`: его носит перевод чужой живой категории.
      [Language.en],
    );

    await service.remove('cat1', 'admin-actor-1');

    const baseSlugLanguages = slugRedirects.record.mock.calls
      .filter((call) => (call[0] as { oldSlug: string }).oldSlug === 'fiction')
      .map((call) => (call[0] as { language: Language }).language);
    // Только `ru`: в `en` адрес жив и 308 увёл бы посетителя с работающей страницы.
    expect(baseSlugLanguages).toEqual([Language.ru]);
    // Слаги самих переводов при этом обслуживаются обычным порядком, оба.
    expect(slugRedirects.record).toHaveBeenCalledTimes(3);
  });

  /**
   * 🔴 Посадка на вынос `recordAddressSuccessor` (решение арбитра 22.09.2026).
   * Преемника выбирают три адреса: слаг перевода на двух путях смерти и базовый
   * слаг в `remove()`. Признак живости и форма уборки у них разные намеренно,
   * а вот выбор преемника обязан быть один — иначе следующая правка D1 («идём
   * к деду», «не писать на скрытого родителя») ляжет в один путь и минует второй,
   * и два публичных адреса одной категории начнут отвечать по-разному.
   *
   * Кейс краснеет от расхождения: верни одному из вызывающих собственный выбор
   * адресата — например, базовому слагу `parentBase` вместо перевода родителя —
   * и `es` перестанет совпадать с `ru` по форме, а `en` получит запись, которой
   * при отсутствии перевода у родителя быть не должно.
   */
  it('LEGACY-392: преемника оба пути выбирают одинаково — перевод родителя того же языка', async () => {
    arrangeRemove(
      [
        { language: Language.ru, slug: 'roman' },
        // У `en` перевод категории есть, а у родителя — нет: ни один из двух
        // адресов этого языка преемника получить не должен.
        { language: Language.en, slug: 'novel' },
      ],
      [
        { language: Language.ru, slug: 'hudozhestvennaya-literatura' },
        // ⚠️ У `es` перевод есть у родителя, но не было у самой категории —
        // значит базовый слаг там адресом не был, и 308 не пишется ни одним
        // из путей. Строка стоит здесь нарочно: она отделяет «преемник есть»
        // от «адрес был живым».
        { language: Language.es, slug: 'ficcion' },
      ],
    );

    await service.remove('cat1', 'admin-actor-1');

    // Два: слаг перевода в `ru` и базовый слаг в `ru`. `en` — нет преемника,
    // `es` — не было адреса.
    expect(slugRedirects.record).toHaveBeenCalledTimes(2);
    // Путь перевода и путь базового слага в одном языке дают один и тот же адресат.
    const ruTargets = slugRedirects.record.mock.calls
      .filter((call) => (call[0] as { language: Language }).language === Language.ru)
      .map((call) => (call[0] as { newSlug: string }).newSlug);
    expect(ruTargets).toEqual(['hudozhestvennaya-literatura', 'hudozhestvennaya-literatura']);
    // Язык без перевода у родителя не получает ничего ни от одного из путей.
    expect(slugRedirects.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ language: Language.en }),
      expect.anything(),
    );
    // Язык, где перевода не было у самой категории, — тоже: преемник там есть,
    // а живого адреса не было.
    expect(slugRedirects.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ language: Language.es }),
      expect.anything(),
    );
  });

  /**
   * 🔴 Порядок для базового слага отдельным кейсом: соседний проверяет его на слагах
   * переводов и остался бы зелёным, встань запись базового слага после уборки.
   * А встань она после — `deleteMany` по `newSlug: 'fiction'` снёс бы строки прежних
   * базовых слагов этой же категории раньше, чем `record` перевёл бы их на родителя
   * (переписывание цепочек в `SlugRedirectService.record`). Это дефект `LEGACY-390`,
   * возвращённый на второй адрес.
   */
  it('LEGACY-392: запись с базового слага идёт до уборки записей, ведущих на него', async () => {
    const order: string[] = [];
    arrangeRemove(
      [{ language: Language.ru, slug: 'roman' }],
      [{ language: Language.ru, slug: 'hudozhestvennaya-literatura' }],
    );
    slugRedirects.record.mockImplementation((change: { oldSlug: string }) => {
      order.push(`record:${change.oldSlug}`);
      return Promise.resolve(undefined);
    });
    prisma.slugRedirect.deleteMany.mockImplementation((args: { where: { newSlug: string } }) => {
      order.push(`deleteMany:${args.where.newSlug}`);
      return Promise.resolve({ count: 0 });
    });

    await service.remove('cat1', 'admin-actor-1');

    expect(order.indexOf('record:fiction')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('deleteMany:fiction')).toBeGreaterThan(order.indexOf('record:fiction'));
  });

  it('LEGACY-390: у корневой категории родителя нет — редиректов не пишется', async () => {
    arrangeRemove([{ language: Language.ru, slug: 'roman' }], null);

    await service.remove('cat1', 'admin-actor-1');

    expect(slugRedirects.record).not.toHaveBeenCalled();
    // Адрес всё равно обязан перестать вести в никуда.
    expect(prisma.slugRedirect.deleteMany).toHaveBeenCalledWith({
      where: { entityType: 'category', language: Language.ru, newSlug: 'roman' },
    });
  });

  it('LEGACY-351: getByLangSlugWithBooks ограничивает groupBy книгами своей страницы', async () => {
    prisma.categoryTranslation.findUnique.mockResolvedValue({
      category: { id: 'cat1', name: 'Cat', slug: 'cat' },
      seo: null,
      description: null,
    });
    prisma.book = {
      count: jest.fn().mockResolvedValue(2),
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

  it('LEGACY-377: getByLangSlugWithBooks выбирает страницу и отдаёт честный meta', async () => {
    prisma.categoryTranslation.findUnique.mockResolvedValue({
      category: { id: 'cat1', name: 'Cat', slug: 'cat' },
      seo: null,
      description: null,
    });
    const findMany = jest.fn().mockResolvedValue([{ id: 'b3', slug: 'b3', versions: [] }]);
    prisma.book = { count: jest.fn().mockResolvedValue(7), findMany };
    prisma.bookVersion.findMany.mockResolvedValue([]);
    prisma.bookRating.groupBy.mockResolvedValue([]);

    const res = await service.getByLangSlugWithBooks(Language.en, 'cat', 2, 3);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 3,
        take: 3,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    expect(res.meta).toEqual({ total: 7, page: 2, limit: 3, totalPages: 3 });
  });

  it('LEGACY-377: getByLangSlugWithBooks не ходит за страницей за пределами выдачи', async () => {
    prisma.categoryTranslation.findUnique.mockResolvedValue({
      category: { id: 'cat1', name: 'Cat', slug: 'cat' },
      seo: null,
      description: null,
    });
    const findMany = jest.fn();
    prisma.book = { count: jest.fn().mockResolvedValue(2), findMany };
    prisma.bookVersion.findMany.mockResolvedValue([]);
    prisma.bookRating.groupBy.mockResolvedValue([]);

    const res = await service.getByLangSlugWithBooks(Language.en, 'cat', 5, 10);

    expect(findMany).not.toHaveBeenCalled();
    expect(res.data).toEqual([]);
    expect(res.meta.total).toBe(2);
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

  // LEGACY-416. Публичный список отдавал термины без `parentId`, поэтому боковая
  // колонка страницы таксономии (`TaxonomyDetailPage.tsx`) сравнивала
  // `undefined === category.id` и `undefined === null` — оба условия ложны
  // всегда, и дети/соседи не отрисовывались ни на одной странице категории.
  it('LEGACY-416: list проецирует parentId, включая null для корневого термина', async () => {
    prisma.$transaction = jest
      .fn()
      .mockImplementation((ops: Array<Promise<unknown>>) => Promise.all(ops));
    prisma.category.count.mockResolvedValue(2);
    prisma.category.findMany.mockResolvedValue([
      {
        id: 'root',
        name: 'Fiction',
        slug: 'fiction',
        key: 'fiction',
        type: 'category',
        parentId: null,
        indexable: true,
        isVisible: true,
        sortOrder: 0,
        translations: [],
      },
      {
        id: 'child',
        name: 'Poetry',
        slug: 'poetry',
        key: 'poetry',
        type: 'category',
        parentId: 'root',
        indexable: true,
        isVisible: true,
        sortOrder: 0,
        translations: [],
      },
    ]);
    prisma.$queryRaw.mockResolvedValue([]);

    const res = await service.list(1, 20, 'category');

    expect(res.data.find((item) => item.id === 'root')?.parentId).toBeNull();
    expect(res.data.find((item) => item.id === 'child')?.parentId).toBe('root');
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

  /**
   * 🔴 LEGACY-005. Ответ привязки уезжал наружу сырым объектом Prisma: запрос без
   * `select` тянул бы все скаляры `BookCategory`, и форма ответа держалась на совпадении
   * модели с DTO. Мёртвая `isPrimary` в этот ответ и уезжала.
   */
  it('ответ привязки собирается белым списком, а не сырой строкой модели', async () => {
    prisma.bookVersion.findUnique = jest.fn().mockResolvedValue({ id: 'v1', bookId: 'b1' });
    prisma.category.findUnique.mockResolvedValue({ id: 'c1' });
    prisma.bookVersion.findMany = jest.fn().mockResolvedValue([{ id: 'v1' }]);
    prisma.bookCategory.findFirst.mockResolvedValue(null);

    await service.attachCategoryToVersion('v1', 'c1');

    // Последний вызов — тот, чей результат и есть тело ответа: до него идёт
    // проверка существования связи у каждой языковой версии книги.
    // Число вызовов зафиксировано рядом (`L-005`): без него допишут ниже по методу
    // ещё один `findFirst`, «последний вызов» станет другим запросом, и `select`
    // на проверяемом можно будет снять, не покраснив ничего.
    const calls = prisma.bookCategory.findFirst.mock.calls;
    expect(calls).toHaveLength(2);
    const [args] = calls[calls.length - 1] as [Record<string, unknown>];
    expect(args.select).toEqual({
      id: true,
      bookVersionId: true,
      categoryId: true,
      sortOrder: true,
    });
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

  /**
   * `LEGACY-400`. `Seo` и перевод пишутся одной транзакцией: раньше это была
   * компенсация — запись `Seo` на пуле, затем `categoryTranslation.create`
   * на пуле, и при её отказе `catch` удалял `Seo` вызовом
   * `seo.delete(...).catch(() => {})`, глотая отказ самой уборки.
   */
  // `tx` здесь отдельный объект, а не `prisma`: запись мимо `tx` иначе прошла бы незамеченной (`L-016`).
  const withSeparateTx = () => {
    const tx = {
      seo: { create: jest.fn().mockResolvedValue({ id: 7 }), delete: jest.fn() },
      categoryTranslation: { create: jest.fn().mockResolvedValue({ id: 'tr1' }) },
    };
    prisma.$transaction = jest.fn((cb: (client: typeof tx) => unknown) => cb(tx));
    return tx;
  };

  it('createTranslation: Seo и перевод пишутся одной транзакцией', async () => {
    prisma.category.findUnique.mockResolvedValue({ id: 'c1' });
    const tx = withSeparateTx();

    await service.createTranslation('c1', {
      language: Language.en,
      name: 'Poetry',
      slug: 'poetry',
      seo: { metaTitle: 'T' },
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.seo.create).toHaveBeenCalledTimes(1);
    expect(tx.seo.create).toHaveBeenCalledWith({ data: { metaTitle: 'T' } });
    expect(tx.categoryTranslation.create).toHaveBeenCalledTimes(1);
    expect(tx.categoryTranslation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ seoId: 7 }) }),
    );
    expect(prisma.seo.create).not.toHaveBeenCalled();
    expect(prisma.categoryTranslation.create).not.toHaveBeenCalled();
  });

  it('createTranslation: категория удалена в окне гонки — P2003 читается как 404', async () => {
    prisma.category.findUnique.mockResolvedValue({ id: 'c1' });
    const tx = withSeparateTx();
    tx.categoryTranslation.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: 'test' }),
    );
    await expect(
      service.createTranslation('c1', { language: Language.en, name: 'P', slug: 'p' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('createTranslation: P2002 — 400 без ручной уборки Seo', async () => {
    prisma.category.findUnique.mockResolvedValue({ id: 'c1' });
    const tx = withSeparateTx();
    tx.categoryTranslation.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }),
    );

    await expect(
      service.createTranslation('c1', {
        language: Language.en,
        name: 'Poetry',
        slug: 'poetry',
        seo: { metaTitle: 'T' },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Транзакция откатила и Seo сама — ручной компенсации нет ни через tx, ни через пул.
    expect(tx.seo.delete).not.toHaveBeenCalled();
    expect(prisma.seo.delete).not.toHaveBeenCalled();
  });

  /**
   * `LEGACY-085`, утверждающие тесты. До 15.09.2026 здесь стоял характеризующий:
   * удаление перевода не писало в историю слагов ничего, и адрес умирал в 404.
   * Владелец выбрал редирект на родителя там, где родитель есть (вариант D),
   * форму краевого случая выбрал арбитр (D1, `decisions-log.md` 15.09.2026):
   * только прямой родитель и только при наличии у него перевода на том же языке.
   *
   * Три случая ниже покрывают обе половины решения. Одного мало: «редирект пишется»
   * без «и не пишется, когда писать некуда» не отличает исполненную политику
   * от безусловной записи на что попало.
   */
  it('LEGACY-085: удаление перевода уводит на родителя того же языка', async () => {
    prisma.categoryTranslation.findUnique.mockResolvedValue({
      categoryId: 'cat1',
      language: Language.ru,
      slug: 'roman',
      seoId: null,
    });
    prisma.categoryTranslation.delete.mockResolvedValue({});
    // Слаг не занят ничьим базовым `Category.slug` — публичный резолв на него ответит 404,
    // значит 308 действительно дойдёт до посетителя.
    prisma.category.findFirst.mockResolvedValue(null);
    prisma.category.findUnique.mockResolvedValue({
      parent: { translations: [{ slug: 'hudozhestvennaya-literatura' }] },
    });

    await service.deleteTranslation('cat1', Language.ru, 'admin-actor-1');

    expect(prisma.categoryTranslation.delete).toHaveBeenCalledTimes(1);
    expect(slugRedirects.record).toHaveBeenCalledTimes(1);
    expect(slugRedirects.record).toHaveBeenCalledWith(
      {
        entityType: 'category',
        language: Language.ru,
        oldSlug: 'roman',
        newSlug: 'hudozhestvennaya-literatura',
      },
      expect.anything(),
    );
  });

  it('LEGACY-085: родитель без перевода на этот язык редиректа не даёт — остаётся 404', async () => {
    prisma.categoryTranslation.findUnique.mockResolvedValue({
      categoryId: 'cat1',
      language: Language.ru,
      slug: 'roman',
      seoId: null,
    });
    prisma.categoryTranslation.delete.mockResolvedValue({});
    prisma.category.findFirst.mockResolvedValue(null);
    // Родитель есть, но переводов на `ru` у него нет — `where: { language }` вернул пусто.
    prisma.category.findUnique.mockResolvedValue({ parent: { translations: [] } });

    await service.deleteTranslation('cat1', Language.ru, 'admin-actor-1');

    expect(prisma.categoryTranslation.delete).toHaveBeenCalledTimes(1);
    expect(slugRedirects.record).not.toHaveBeenCalled();
  });

  it('LEGACY-085: слаг, занятый базовым Category.slug, редиректа не получает', async () => {
    prisma.categoryTranslation.findUnique.mockResolvedValue({
      categoryId: 'cat1',
      language: Language.ru,
      slug: 'roman',
      seoId: null,
    });
    prisma.categoryTranslation.delete.mockResolvedValue({});
    // Тот же слаг — базовый у какой-то категории: публичный резолв на него ответит
    // 200 с `translation: null`, фронт сделает 404 мимо истории слагов, и 308
    // не выдастся никогда. Писать запись в такой ситуации — заводить строку,
    // которой ничто не соответствует.
    prisma.category.findFirst.mockResolvedValue({ id: 'cat1' });

    await service.deleteTranslation('cat1', Language.ru, 'admin-actor-1');

    expect(prisma.categoryTranslation.delete).toHaveBeenCalledTimes(1);
    expect(slugRedirects.record).not.toHaveBeenCalled();
    // 🔴 И уборки тоже нет: адрес пережил удаление перевода, записи на него ведут
    // на живую страницу и работают. Снести их значило бы выдать 404 по индексированному
    // адресу, а он не отзывается (решение арбитра 15.09.2026). Прежде здесь стояло
    // ещё и `category.findUnique).not.toHaveBeenCalled()` — проверка экономии запроса;
    // с переходом обоих путей на общий метод родитель читается до отбора, и это
    // ожидание описывало бы устройство, а не политику.
    expect(prisma.slugRedirect.deleteMany).not.toHaveBeenCalled();
  });

  it('LEGACY-085: записи, ведущие на исчезающий слаг, снимаются', async () => {
    prisma.categoryTranslation.findUnique.mockResolvedValue({
      categoryId: 'cat1',
      language: Language.ru,
      slug: 'roman',
      seoId: null,
    });
    prisma.categoryTranslation.delete.mockResolvedValue({});
    prisma.category.findFirst.mockResolvedValue(null);
    prisma.category.findUnique.mockResolvedValue({ parent: null });

    await service.deleteTranslation('cat1', Language.ru, 'admin-actor-1');

    // Иначе адрес, который вёл сюда 308-м, после исчезновения цели указывал бы в 404.
    expect(prisma.slugRedirect.deleteMany).toHaveBeenCalledWith({
      where: { entityType: 'category', language: Language.ru, newSlug: 'roman' },
    });
  });

  /**
   * Тот же порядок на втором пути смерти адреса. Оба пути зовут общий
   * `retireCategoryAddress`, и этот кейс держит их вместе: разойдутся — покраснеет
   * ровно он, а не абстрактное «политика разъехалась» (`LEGACY-390`).
   */
  it('LEGACY-085: преемник записывается до уборки — цепочка прежних слагов уцелевает', async () => {
    const order: string[] = [];
    prisma.categoryTranslation.findUnique.mockResolvedValue({
      categoryId: 'cat1',
      language: Language.ru,
      slug: 'roman',
      seoId: null,
    });
    prisma.categoryTranslation.delete.mockResolvedValue({});
    prisma.category.findFirst.mockResolvedValue(null);
    prisma.category.findUnique.mockResolvedValue({
      parent: { translations: [{ slug: 'hudozhestvennaya-literatura' }] },
    });
    slugRedirects.record.mockImplementation(() => {
      order.push('record');
      return Promise.resolve(undefined);
    });
    prisma.slugRedirect.deleteMany.mockImplementation(() => {
      order.push('deleteMany');
      return Promise.resolve({ count: 0 });
    });

    await service.deleteTranslation('cat1', Language.ru, 'admin-actor-1');

    expect(order).toEqual(['record', 'deleteMany']);
  });

  it('LEGACY-085: у корневой категории родителя нет — остаётся 404', async () => {
    prisma.categoryTranslation.findUnique.mockResolvedValue({
      categoryId: 'cat1',
      language: Language.ru,
      slug: 'roman',
      seoId: null,
    });
    prisma.categoryTranslation.delete.mockResolvedValue({});
    prisma.category.findFirst.mockResolvedValue(null);
    prisma.category.findUnique.mockResolvedValue({ parent: null });

    await service.deleteTranslation('cat1', Language.ru, 'admin-actor-1');

    expect(prisma.categoryTranslation.delete).toHaveBeenCalledTimes(1);
    expect(slugRedirects.record).not.toHaveBeenCalled();
  });
  /**
   * 🔴 `LEGACY-015`, пачка `T20`. Удаление термина таксономии — административное
   * действие по критерию из докблока `AdminAuditEvent`: маршрут закрыт ролью,
   * `user` в `@Roles` нет, строка стирается физически.
   *
   * Отдельных событий на переводы, снесённые вместе с категорией, нет намеренно
   * (решение арбитра 20.09.2026): в `AdminAuditAction` нет ни одного утверждения
   * о переводе, которое их снос сделал бы ложным. Но их публичные адреса умирают
   * вместе с ними и после `deleteMany` невосстановимы — поэтому список уходит
   * в `payload` события самой категории, и состав проверяется целиком, а не
   * `toMatchObject`: лишнее поле в журнале так же неверно, как потерянное.
   */
  describe('журнал административных действий (LEGACY-015, T20)', () => {
    it('remove пишет CATEGORY_DELETED со списком умерших переводов', async () => {
      // Стенд — общий `arrangeRemove`, а не своя копия: он единственный разводит
      // два разных `categoryTranslation.findMany` по `where` (умирающие адреса
      // против живых носителей базового слага) и на третью форму бросает отказ.
      // Рукописная копия отвечала бы `dying` на оба вопроса, и поломка отбора
      // языков в уборке редиректов прошла бы мимо (`STYLE_GUIDE.md §1`).
      const dying = [
        { language: Language.ru, slug: 'roman' },
        { language: Language.en, slug: 'novel' },
      ];
      arrangeRemove(dying, null);

      await service.remove('cat1', 'admin-actor-1');

      expect(adminAudit.record).toHaveBeenCalledTimes(1);
      // ⚠️ Первый аргумент `record` здесь НЕ проверяется: `$transaction` общего
      // стенда отдаёт колбэку сам `prisma`, и сверка была бы истинна при любом
      // аргументе. Настоящая посадка на `LEGACY-036` — в тесте порядка ниже,
      // где `tx` отдельным объектом (`L-016`).
      expect(adminAudit.record.mock.calls[0][1]).toEqual({
        action: 'CATEGORY_DELETED',
        targetType: 'CATEGORY',
        targetId: 'cat1',
        actorUserId: 'admin-actor-1',
        payload: { slug: 'fiction', translations: dying },
      });
    });

    /**
     * Порядок, а не только факт записи: событие обязано лежать внутри того же
     * замка дерева, что и само удаление. Запись, выехавшая из-под замка, даёт
     * журнал, который расходится с данными при встречной правке дерева.
     */
    it('запись идёт под тем же замком дерева, что и удаление', async () => {
      const order: string[] = [];
      const tx = {
        $queryRaw: jest.fn(() => {
          order.push('lock');
          return Promise.resolve([]);
        }),
        category: {
          findUnique: jest.fn().mockResolvedValue({ id: 'cat1', parent: null }),
          count: jest.fn().mockResolvedValue(0),
          delete: jest.fn(() => {
            order.push('delete');
            return Promise.resolve({ id: 'cat1', slug: 'fiction' });
          }),
          findFirst: jest.fn().mockResolvedValue(null),
        },
        bookCategory: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
        categoryTranslation: {
          findMany: jest.fn().mockResolvedValue([]),
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        slugRedirect: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      };
      adminAudit.record.mockImplementation(() => {
        order.push('audit');
        return Promise.resolve(undefined);
      });
      prisma.$transaction = jest
        .fn()
        .mockImplementation((cb: (client: unknown) => unknown) => cb(tx));

      await service.remove('cat1', 'admin-actor-1');

      expect(order).toEqual(['lock', 'delete', 'audit']);
      // Посадка на `LEGACY-036`: здесь `tx` — отдельный объект, не равный `prisma`,
      // поэтому подмена клиента в сервисе роняет тест, а не проходит молча.
      expect(adminAudit.record.mock.calls[0][0]).toBe(tx);
    });

    it('несуществующая категория журнала не касается', async () => {
      prisma.category.findUnique.mockResolvedValue(null);

      await expect(service.remove('missing', 'admin-actor-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(adminAudit.record).not.toHaveBeenCalled();
    });

    it('отказ из-за детей журнала не касается', async () => {
      prisma.category.findUnique.mockResolvedValue({ id: 'cat1' });
      prisma.category.count.mockResolvedValue(1);

      await expect(service.remove('cat1', 'admin-actor-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(adminAudit.record).not.toHaveBeenCalled();
    });

    /**
     * ⚠️ `targetId` — идентификатор **категории**, хотя у строки перевода есть своё
     * `id`: язык стоит в `payload`, и вся история термина собирается одной выборкой
     * по `targetId` (решение арбитра 20.09.2026). Проверяется буквально — подстановка
     * `tr.id` компилируется и осталась бы незамеченной.
     */
    it('deleteTranslation пишет CATEGORY_TRANSLATION_DELETED на саму категорию', async () => {
      prisma.categoryTranslation.findUnique.mockResolvedValue({
        id: 'translation-row-1',
        categoryId: 'cat1',
        language: Language.ru,
        slug: 'roman',
        seoId: null,
      });
      prisma.categoryTranslation.delete.mockResolvedValue({});
      prisma.category.findFirst.mockResolvedValue(null);
      prisma.category.findUnique.mockResolvedValue({ parent: null });

      await service.deleteTranslation('cat1', Language.ru, 'admin-actor-1');

      expect(adminAudit.record).toHaveBeenCalledTimes(1);
      expect(adminAudit.record.mock.calls[0][1]).toEqual({
        action: 'CATEGORY_TRANSLATION_DELETED',
        targetType: 'CATEGORY',
        targetId: 'cat1',
        actorUserId: 'admin-actor-1',
        payload: { language: Language.ru, slug: 'roman' },
      });
    });

    /**
     * Инвариант «событие = изменение состояния» (`M5`, 11.09.2026): удалять было
     * нечего, значит и записывать нечего. Без этого теста тихий `return` легко
     * заменить на запись «на всякий случай», и `CATEGORY_TRANSLATION_DELETED`
     * перестанет означать «перевод был и его не стало».
     */
    it('отсутствующий перевод журнала не касается', async () => {
      prisma.categoryTranslation.findUnique.mockResolvedValue(null);

      await service.deleteTranslation('cat1', Language.ru, 'admin-actor-1');

      expect(adminAudit.record).not.toHaveBeenCalled();
    });
  });
});
