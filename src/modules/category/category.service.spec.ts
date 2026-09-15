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
  /**
   * Модель `book` общая заглушка не заводит: её подставляют точечно те тесты,
   * которым нужен обход книг каталога. Отсюда необязательность поля.
   */
  book?: {
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
});

describe('CategoryService', () => {
  let service: CategoryService;
  let prisma: PrismaStub;
  let indexability: { recomputeForTerms: jest.Mock };
  let slugRedirects: { record: jest.Mock; resolve: jest.Mock };

  beforeEach(() => {
    prisma = createPrismaStub();
    prisma.$transaction = jest
      .fn()
      .mockImplementation((cb: (tx: PrismaStub) => unknown) => cb(prisma as unknown as PrismaStub));
    indexability = { recomputeForTerms: jest.fn().mockResolvedValue(undefined) };
    slugRedirects = {
      record: jest.fn().mockResolvedValue(undefined),
      resolve: jest.fn().mockResolvedValue(null),
    };
    service = new CategoryService(
      prisma as unknown as PrismaService,
      slugRedirects as unknown as SlugRedirectService,
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
        findFirst: jest.fn(() => {
          order.push('tx.categoryTranslation.findFirst');
          return Promise.resolve(null);
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

    await service.remove('A');

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
      'tx.categoryTranslation.findFirst',
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

    await expect(service.remove('A')).rejects.toThrow('db is down');
    expect(tx.category.delete).not.toHaveBeenCalled();
  });

  it('remove rejects when category has children', async () => {
    prisma.category.findUnique.mockResolvedValue({ id: 'A' });
    prisma.category.count.mockResolvedValue(1);
    await expect(service.remove('A')).rejects.toBeInstanceOf(BadRequestException);
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
  ) => {
    prisma.category.findUnique.mockResolvedValue({
      id: 'cat1',
      parent: parentTranslations === null ? null : { translations: parentTranslations },
    });
    prisma.category.count.mockResolvedValue(0);
    prisma.categoryTranslation.findMany.mockResolvedValue(dying);
    prisma.bookCategory.deleteMany.mockResolvedValue({ count: 0 });
    prisma.categoryTranslation.deleteMany.mockResolvedValue({ count: dying.length });
    prisma.category.delete.mockResolvedValue({ id: 'cat1', slug: 'fiction' });
    prisma.slugRedirect.deleteMany.mockResolvedValue({ count: 0 });
    prisma.category.findFirst.mockResolvedValue(null);
    // Базовый слаг удалённой категории по умолчанию никем не занят: записи, ведущие
    // на него, подлежат уборке.
    prisma.categoryTranslation.findFirst.mockResolvedValue(null);
  };

  it('LEGACY-390: удаление категории уводит на родителя каждый язык, а не только первый', async () => {
    arrangeRemove(
      [
        { language: Language.ru, slug: 'roman' },
        { language: Language.en, slug: 'novel' },
      ],
      [
        { language: Language.ru, slug: 'hudozhestvennaya-literatura' },
        { language: Language.en, slug: 'fiction' },
      ],
    );

    await service.remove('cat1');

    expect(slugRedirects.record).toHaveBeenCalledTimes(2);
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
      { entityType: 'category', language: Language.en, oldSlug: 'novel', newSlug: 'fiction' },
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

    await service.remove('cat1');

    // Два вызова: отбор занятости исчезающего слага перевода и проверка того,
    // жив ли ещё базовый слаг удалённой категории.
    expect(prisma.category.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.category.findFirst).toHaveBeenCalledWith({
      where: { slug: 'roman', id: { not: 'cat1' } },
      select: { id: true },
    });
    expect(slugRedirects.record).toHaveBeenCalledTimes(1);
  });

  it('LEGACY-390: слаг, занятый живой чужой категорией, редиректа не получает', async () => {
    arrangeRemove(
      [{ language: Language.ru, slug: 'roman' }],
      [{ language: Language.ru, slug: 'hudozhestvennaya-literatura' }],
    );
    // Тот же слаг — базовый у другой, остающейся жить категории: публичный резолв
    // ответит по ней 200, и 308 не дошёл бы до посетителя никогда.
    prisma.category.findFirst.mockResolvedValue({ id: 'other' });

    await service.remove('cat1');

    expect(slugRedirects.record).not.toHaveBeenCalled();
  });

  it('LEGACY-390: записи, ведущие на исчезающие слаги, снимаются по каждому языку', async () => {
    arrangeRemove(
      [
        { language: Language.ru, slug: 'roman' },
        { language: Language.en, slug: 'novel' },
      ],
      [{ language: Language.ru, slug: 'hudozhestvennaya-literatura' }],
    );

    await service.remove('cat1');

    // Иначе адрес, который вёл сюда 308-м, после исчезновения цели указывал бы в 404.
    // Счётчик обязателен рядом с `toHaveBeenCalledWith` (`L-005`): без него уборка,
    // расширенная до `deleteMany({ entityType, language })` без `newSlug`, снесла бы
    // историю всех категорий языка и оставила обе проверки зелёными.
    expect(prisma.slugRedirect.deleteMany).toHaveBeenCalledTimes(3);
    expect(prisma.slugRedirect.deleteMany).toHaveBeenCalledWith({
      where: { entityType: 'category', language: Language.ru, newSlug: 'roman' },
    });
    expect(prisma.slugRedirect.deleteMany).toHaveBeenCalledWith({
      where: { entityType: 'category', language: Language.en, newSlug: 'novel' },
    });
    // Третий вызов — записи, ведущие на исчезнувший БАЗОВЫЙ слаг: их пишет
    // `recordBaseSlugChange` сразу на пять языков, поэтому отбора по языку здесь нет.
    expect(prisma.slugRedirect.deleteMany).toHaveBeenCalledWith({
      where: { entityType: 'category', newSlug: 'fiction' },
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

    await service.remove('cat1');

    expect(slugRedirects.record).toHaveBeenCalledTimes(1);
    expect(slugRedirects.record).toHaveBeenCalledWith(
      expect.objectContaining({ language: Language.ru }),
      expect.anything(),
    );
    // Уборка идёт по каждому языку независимо от того, нашёлся ли преемник,
    // плюс отдельный вызов на базовый слаг удалённой категории.
    expect(prisma.slugRedirect.deleteMany).toHaveBeenCalledTimes(3);
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

    await service.remove('cat1');

    expect(order[0]).toBe('record');
    expect(order).toContain('deleteMany');
  });

  /**
   * Обратная половина уборки базового слага: слаг, который держит живой перевод,
   * продолжает резолвиться публично, и 308 на него — верный. Снести такие записи
   * значило бы превратить рабочий редирект в 404.
   */
  it('LEGACY-390: базовый слаг, оставшийся живым, записи на себя сохраняет', async () => {
    arrangeRemove([{ language: Language.ru, slug: 'roman' }], null);
    // Тот же базовый слаг носит перевод другой, остающейся жить категории.
    prisma.categoryTranslation.findFirst.mockResolvedValue({ id: 'tr-other' });

    await service.remove('cat1');

    expect(prisma.slugRedirect.deleteMany).not.toHaveBeenCalledWith({
      where: { entityType: 'category', newSlug: 'fiction' },
    });
  });

  /**
   * 🔴 Ветка живого адреса на пути удаления категории целиком. Слаг держит базовый
   * `Category.slug` чужой живой категории, значит публичный резолв по нему по-прежнему
   * отвечает 200 через фоллбэк. Записи, которые вели сюда 308-м, ведут на работающую
   * страницу — снести их значит выдать 404 по индексированному адресу, а он
   * не отзывается (решение арбитра 15.09.2026).
   */
  it('LEGACY-390: при живом чужом базовом слаге записи на него не снимаются', async () => {
    arrangeRemove(
      [{ language: Language.ru, slug: 'roman' }],
      [{ language: Language.ru, slug: 'hudozhestvennaya-literatura' }],
    );
    prisma.category.findFirst.mockResolvedValue({ id: 'other' });

    await service.remove('cat1');

    expect(slugRedirects.record).not.toHaveBeenCalled();
    expect(prisma.slugRedirect.deleteMany).not.toHaveBeenCalledWith({
      where: { entityType: 'category', language: Language.ru, newSlug: 'roman' },
    });
  });

  it('LEGACY-390: у корневой категории родителя нет — редиректов не пишется', async () => {
    arrangeRemove([{ language: Language.ru, slug: 'roman' }], null);

    await service.remove('cat1');

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

    await service.deleteTranslation('cat1', Language.ru);

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

    await service.deleteTranslation('cat1', Language.ru);

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

    await service.deleteTranslation('cat1', Language.ru);

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

    await service.deleteTranslation('cat1', Language.ru);

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

    await service.deleteTranslation('cat1', Language.ru);

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

    await service.deleteTranslation('cat1', Language.ru);

    expect(prisma.categoryTranslation.delete).toHaveBeenCalledTimes(1);
    expect(slugRedirects.record).not.toHaveBeenCalled();
  });
});
