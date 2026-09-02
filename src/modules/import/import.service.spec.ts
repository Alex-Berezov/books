import { BadRequestException } from '@nestjs/common';
import { CategoryType, Language } from '@prisma/client';
import { CategoryTreeService } from '../category/category-tree.service';
import { TagLockService } from '../tags/tag-lock.service';
import { ImportService } from './import.service';
import type { ImportCategoryDto } from './dto/import-category.dto';
import type { ImportTagDto } from './dto/import-tag.dto';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SlugRedirectService } from '../slug-redirect/slug-redirect.service';

/**
 * Импорт термина и его переводов — одна транзакция (`LEGACY-131`).
 *
 * Раньше ветка создания шла несколькими независимыми `await` подряд: `create`,
 * `updateParentId`, затем цикл по переводам. Отказ на любом шаге — упавшее
 * соединение, конфликт слага перевода, ошибка валидации — оставлял в базе
 * категорию или тег без переводов. Такая запись выглядит рабочей: у неё есть
 * `slug` и `key`, она попадает в списки и в дерево, но публичные маршруты
 * отбирают по переводу нужного языка и не показывают её ни на одной языковой
 * версии сайта. Оператор при этом видит успешный импорт.
 *
 * ⚠️ Спеки смотрят **на то, каким клиентом сделана каждая запись**, а не только
 * на факт вызова `$transaction`. Обёртка без прокидывания `tx` бесполезна:
 * оставленный на `this.prisma` вызов внутри транзакции уходит на другое
 * соединение и вместе с ней не откатывается. Поэтому журнал ниже помечает
 * каждый вызов тем, кто его сделал: `root` — корневой клиент, `tx` — клиент
 * транзакции.
 */

type WriteLog = string[];

interface FakeModel {
  findUnique: jest.Mock;
  // 🔴 `LEGACY-315`. Второй проход в конце партии читает детей терминов,
  // сменивших тип, через `findMany`; без него в поддельном клиенте спека падает
  // не на своём предмете.
  findMany: jest.Mock;
  // 🔴 `LEGACY-303`. Проверка второго края ребра спрашивает базу об одном
  // несовпадающем ребёнке; без `findFirst` в поддельном клиенте спека падает
  // не на своём предмете.
  findFirst: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
}

interface FakeClient {
  // 🔴 `LEGACY-274`. Обе транзакции импорта категорий берут рекомендательную
  // блокировку дерева первым оператором; без `$queryRaw` в поддельном клиенте
  // спека падает не на своём предмете.
  $queryRaw: jest.Mock;
  category: FakeModel;
  categoryTranslation: Pick<FakeModel, 'create' | 'update'>;
  tag: FakeModel;
  tagTranslation: Pick<FakeModel, 'create' | 'update'>;
}

const makeClient = (label: 'root' | 'tx', log: WriteLog): FakeClient => {
  const note = (op: string, result: unknown) =>
    jest.fn().mockImplementation(() => {
      log.push(`${label}.${op}`);
      return Promise.resolve(result);
    });

  const model = (name: string, created: unknown): FakeModel => ({
    findUnique: note(`${name}.findUnique`, null),
    findFirst: note(`${name}.findFirst`, null),
    findMany: note(`${name}.findMany`, []),
    create: note(`${name}.create`, created),
    update: note(`${name}.update`, created),
  });

  return {
    // ⚠️ Метка через двоеточие, а не через точку, намеренно: `delegate-check.mjs`
    // разбирает вид «клиент, точка, имя» как обращение к делегату Prisma
    // и печатает заведомо ложную строку — за ней прячется настоящая находка.
    // ⚠️ Метка берётся из текста запроса, а не пишется одной строкой на все:
    // с 03.09.2026 сырым SQL в этих путях идут ДВА разных замка — блокировка
    // дерева категорий (`pg_advisory_xact_lock`) и замок строки тега
    // (`FOR UPDATE`). Общая метка сделала бы спеку, проверяющую порядок
    // операторов на теге, зелёной и на блокировке дерева.
    $queryRaw: jest.fn().mockImplementation((parts?: { raw?: readonly string[] }) => {
      const sql = (parts?.raw ?? []).join(' ');
      log.push(`${label}:${sql.includes('FOR UPDATE') ? 'lockTagRow' : 'lockTree'}`);
      return Promise.resolve([]);
    }),
    category: model('category', { id: 'cat-1' }),
    categoryTranslation: {
      create: note('categoryTranslation.create', {}),
      update: note('categoryTranslation.update', {}),
    },
    tag: model('tag', { id: 'tag-1' }),
    tagTranslation: {
      create: note('tagTranslation.create', {}),
      update: note('tagTranslation.update', {}),
    },
  };
};

/** Только записи: чтения ходят мимо транзакции законно. */
const writesOf = (log: WriteLog): string[] =>
  log.filter(
    (call) =>
      call.endsWith('.create') ||
      call.endsWith('.update') ||
      call.includes('.slugRedirect.') ||
      call.includes('slugRedirect.record'),
  );

const makeService = (log: WriteLog) => {
  const tx = makeClient('tx', log);
  const root = makeClient('root', log);
  const $transaction = jest
    .fn()
    .mockImplementation((run: (client: FakeClient) => Promise<unknown>) => run(tx));
  const prisma = { ...root, $transaction };

  // ⚠️ История слагов пишется не делегатом Prisma, а `SlugRedirectService`, и
  // клиент он получает **необязательным** аргументом: `record(change, tx?)`.
  // Значит забытый `tx` не ломает ни типы, ни вызов — запись просто уходит на
  // другое соединение и переживает откат. Поэтому фейк журналирует не факт
  // вызова, а то, **какой клиент** в него передали.
  const noteRedirect = (op: string) =>
    jest.fn().mockImplementation((...args: unknown[]) => {
      const client = args[args.length - 1];
      log.push(`${client === tx ? 'tx' : 'root'}.${op}`);
      return Promise.resolve(undefined);
    });
  const slugRedirects = {
    record: noteRedirect('slugRedirect.record'),
    recordBaseSlugChange: noteRedirect('slugRedirect.recordBaseSlugChange'),
  };

  const service = new ImportService(
    prisma as unknown as PrismaService,
    slugRedirects as unknown as SlugRedirectService,
    new CategoryTreeService(prisma as unknown as PrismaService),
    new TagLockService(prisma as unknown as PrismaService),
  );

  return { service, prisma, root, tx, $transaction, slugRedirects };
};

const categoryDto = (parentKey?: string): ImportCategoryDto =>
  ({
    key: 'victorian-literature',
    type: CategoryType.genre,
    parentKey,
    translations: {
      [Language.en]: { name: 'Victorian Literature', slug: 'victorian-literature' },
      [Language.ru]: { name: 'Викторианская литература', slug: 'viktorianskaya-literatura' },
    },
  }) as ImportCategoryDto;

const tagDto = (): ImportTagDto =>
  ({
    key: 'aestheticism',
    name: 'Aestheticism',
    slug: 'aestheticism',
    translations: {
      [Language.en]: { name: 'Aestheticism', slug: 'aestheticism' },
      [Language.ru]: { name: 'Эстетизм', slug: 'estetizm' },
    },
  }) as ImportTagDto;

describe('ImportService — блокировка дерева категорий (LEGACY-274)', () => {
  /**
   * 🔴 Блокировка обязана быть **первым** оператором транзакции. Транзакция,
   * успевшая взять строку категории, встанет на ней во взаимную блокировку
   * с админским `PATCH`, который эту же блокировку уже держит. Проверяется
   * поэтому порядок, а не факт вызова: `expect(...).toHaveBeenCalled()`
   * зеленеет и на строке, поставленной в конец.
   */
  it('создание термина берёт блокировку до первой записи', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);

    root.category.findUnique.mockImplementation(() => {
      log.push('root.category.findUnique');
      return Promise.resolve(null);
    });
    tx.category.findUnique.mockImplementation(() => {
      log.push('tx.category.findUnique');
      return Promise.resolve(null);
    });

    await service.importCategories([categoryDto()]);

    const inTx = log.filter((call) => call.startsWith('tx.') || call.startsWith('tx:'));
    expect(inTx[0]).toBe('tx:lockTree');
  });

  it('обновление термина берёт блокировку до первой записи', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);

    // Термин уже есть — идёт ветка обновления, а не создания.
    //
    // ⚠️ `translations` обязателен: `upsertCategory` перебирает его, решая,
    // создавать перевод или обновлять. Без поля ветка падает на середине,
    // ошибка глотается общим `catch` импорта, и утверждение о порядке
    // оказывается верным случайно — сценарий до переводов не доходит.
    root.category.findUnique.mockImplementation(() => {
      log.push('root.category.findUnique');
      return Promise.resolve({
        id: 'cat-1',
        indexable: true,
        isVisible: true,
        sortOrder: 0,
        translations: [],
      });
    });
    tx.category.findUnique.mockImplementation(() => {
      log.push('tx.category.findUnique');
      return Promise.resolve(null);
    });

    await service.importCategories([categoryDto()]);

    const inTx = log.filter((call) => call.startsWith('tx.') || call.startsWith('tx:'));
    expect(inTx[0]).toBe('tx:lockTree');
  });
});

describe('ImportService — создание термина и переводов одной транзакцией (LEGACY-131)', () => {
  it('пишет категорию, её родителя и переводы только клиентом транзакции', async () => {
    const log: WriteLog = [];
    const { service, root, tx, $transaction } = makeService(log);

    // Родитель есть в базе — иначе импорт отбраковал бы запись до записи вовсе.
    root.category.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('root.category.findUnique');
      return Promise.resolve(args?.where?.key === 'classic-literature' ? { id: 'parent-1' } : null);
    });
    // ⚠️ `LEGACY-312`. Развилка «создание или обновление» решается чтением
    // ВНУТРИ транзакции, поэтому «термина ещё нет» задаётся здесь, а не на
    // клиенте пула. Мок, отдающий строку по ключу термина, уводил бы импорт
    // в ветку обновления, и эта спека проверяла бы не тот путь.
    tx.category.findUnique.mockImplementation((args: { where?: { key?: string; id?: string } }) => {
      log.push('tx.category.findUnique');
      const where = args?.where ?? {};
      if (where.key === 'classic-literature')
        return Promise.resolve({ id: 'parent-1', type: CategoryType.genre });
      if (where.key === 'victorian-literature') return Promise.resolve(null);
      // Подъём по предкам: у родителя своего родителя нет, цикла нет.
      if (where.id === 'parent-1') return Promise.resolve({ parentId: null });
      return Promise.resolve(null);
    });

    const result = await service.importCategories([categoryDto('classic-literature')]);

    expect(result).toEqual({ imported: 1, updated: 0, errors: [] });
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(writesOf(log)).toEqual([
      'tx.category.create',
      'tx.category.update',
      'tx.categoryTranslation.create',
      'tx.categoryTranslation.create',
    ]);

    // ⚠️ Журнала мало: он говорит, кто звал, но не с чем. Ключ термина и ключ
    // родителя — обе строки, и перестановка аргументов `updateParentId`
    // проходит `tsc` молча: `parentId` проставится строке родителя, а сам
    // термин останется в корне дерева.
    expect(tx.category.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ key: 'victorian-literature' }),
    });
    expect(tx.category.findUnique).toHaveBeenCalledWith({
      where: { key: 'classic-literature' },
      select: { id: true, type: true },
    });
    expect(tx.category.update).toHaveBeenCalledWith({
      where: { key: 'victorian-literature' },
      data: { parentId: 'parent-1' },
    });
    expect(tx.categoryTranslation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        categoryId: 'cat-1',
        language: Language.ru,
        slug: 'viktorianskaya-literatura',
      }),
    });
  });

  it('не оставляет категорию вне транзакции, если перевод упал на середине', async () => {
    const log: WriteLog = [];
    const { service, tx, $transaction } = makeService(log);

    let translations = 0;
    tx.categoryTranslation.create.mockImplementation(() => {
      log.push('tx.categoryTranslation.create');
      translations += 1;
      return translations === 2 ? Promise.reject(new Error('slug conflict')) : Promise.resolve({});
    });

    const result = await service.importCategories([categoryDto()]);

    expect(result.imported).toBe(0);
    expect(result.errors).toEqual([{ key: 'victorian-literature', message: 'slug conflict' }]);
    // Единственная транзакция — и ни одной записи мимо неё: иначе категория
    // пережила бы откат и заняла бы slug с key без единого перевода.
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(writesOf(log).filter((call) => call.startsWith('root.'))).toEqual([]);
    expect(log).toContain('tx.category.create');
  });

  it('пишет тег и его переводы только клиентом транзакции', async () => {
    const log: WriteLog = [];
    const { service, tx, $transaction } = makeService(log);

    const result = await service.importTags([tagDto()]);

    expect(result).toEqual({ imported: 1, updated: 0, errors: [] });
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(writesOf(log)).toEqual([
      'tx.tag.create',
      'tx.tagTranslation.create',
      'tx.tagTranslation.create',
    ]);

    expect(tx.tag.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ key: 'aestheticism', slug: 'aestheticism' }),
    });
    expect(tx.tagTranslation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tagId: 'tag-1',
        language: Language.ru,
        slug: 'estetizm',
      }),
    });
  });

  it('не оставляет тег вне транзакции, если перевод упал на середине', async () => {
    const log: WriteLog = [];
    const { service, tx, $transaction } = makeService(log);

    let translations = 0;
    tx.tagTranslation.create.mockImplementation(() => {
      log.push('tx.tagTranslation.create');
      translations += 1;
      return translations === 2 ? Promise.reject(new Error('slug conflict')) : Promise.resolve({});
    });

    const result = await service.importTags([tagDto()]);

    expect(result.imported).toBe(0);
    expect(result.errors).toEqual([{ key: 'aestheticism', message: 'slug conflict' }]);
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(writesOf(log).filter((call) => call.startsWith('root.'))).toEqual([]);
    expect(log).toContain('tx.tag.create');
  });
});

describe('ImportService — обновление термина одной транзакцией (LEGACY-257)', () => {
  /**
   * Термин уже в базе: один перевод есть, второй придёт с импортом.
   *
   * ⚠️ Слаги здесь **намеренно старые** и не совпадают с теми, что придут в
   * `categoryDto()` / `tagDto()`. Совпадающие слаги выглядят безобиднее, но тогда
   * ветка `if (tr.slug && existingTr.slug !== tr.slug)` не исполняется ни разу,
   * и главное утверждение `LEGACY-257` — «история слагов пишется тем же `tx`» —
   * остаётся непроверенным: снятие `tx` у `slugRedirects.record` не красит
   * ничего, потому что вызова просто нет.
   */
  const existingCategory = {
    id: 'cat-1',
    // ⚠️ `type` и `parentId` обязательны: по ним считается `typeChanging`
    // (`LEGACY-308`) и решается, надо ли проверять фактического родителя.
    type: CategoryType.genre,
    parentId: null,
    indexable: true,
    isVisible: true,
    sortOrder: 0,
    translations: [{ language: Language.en, slug: 'victorian-lit-old' }],
  };

  const existingTag = {
    id: 'tag-1',
    slug: 'aestheticism-old',
    indexable: true,
    isVisible: true,
    sortOrder: 0,
    translations: [{ language: Language.en, slug: 'aestheticism-old' }],
  };

  it('пишет базовую строку, родителя, историю слагов и оба перевода одним tx', async () => {
    const log: WriteLog = [];
    const { service, root, tx, $transaction } = makeService(log);

    root.category.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('root.category.findUnique');
      return Promise.resolve(
        args?.where?.key === 'classic-literature' ? { id: 'parent-1' } : existingCategory,
      );
    });
    // ⚠️ Родитель и термин — разные строки: с 20.08.2026 привязка проверяет, что
    // родитель не совпадает с термином, не другого типа и не его потомок
    // (`LEGACY-263`, `LEGACY-264`), и один общий ответ на все чтения означал бы
    // «сам себе родитель».
    tx.category.findUnique.mockImplementation((args: { where?: { key?: string; id?: string } }) => {
      log.push('tx.category.findUnique');
      const where = args?.where ?? {};
      if (where.key === 'classic-literature')
        return Promise.resolve({ id: 'parent-1', type: CategoryType.genre });
      // 🔴 `LEGACY-304`. Дефолты и список переводов берутся из строки,
      // прочитанной внутри транзакции. Мок пула эту строку больше не отдаёт.
      if (where.key === 'victorian-literature') return Promise.resolve(existingCategory);
      if (where.id === 'parent-1') return Promise.resolve({ parentId: null });
      return Promise.resolve(null);
    });

    const result = await service.importCategories([categoryDto('classic-literature')]);

    expect(result).toEqual({ imported: 0, updated: 1, errors: [] });
    // Одна транзакция на весь термин, а не по одной на каждый существующий перевод.
    expect($transaction).toHaveBeenCalledTimes(1);
    // Порядок и состав дословно: сюда входят и привязка родителя
    // (`tx.category.update` вторым), и запись истории слагов.
    expect(writesOf(log)).toEqual([
      'tx.category.update',
      'tx.category.update',
      'tx.slugRedirect.record',
      'tx.categoryTranslation.update',
      'tx.categoryTranslation.create',
    ]);
    expect(tx.category.update).toHaveBeenCalledTimes(2);
    expect(tx.category.update).toHaveBeenCalledWith({
      where: { key: 'victorian-literature' },
      data: { parentId: 'parent-1' },
    });
  });

  it('не считает категорию обновлённой, если перевод упал на середине', async () => {
    const log: WriteLog = [];
    const { service, root, tx, $transaction } = makeService(log);

    root.category.findUnique.mockImplementation(() => {
      log.push('root.category.findUnique');
      return Promise.resolve(existingCategory);
    });
    // 🔴 `LEGACY-304`. Ветку выбирает чтение ВНУТРИ транзакции. Без этого мока
    // тест уходил бы в ветку создания и дублировал соседний кейс, а регрессия
    // именно в ветке обновления оставалась бы непокрытой.
    tx.category.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('tx.category.findUnique');
      return Promise.resolve(args?.where?.key === 'victorian-literature' ? existingCategory : null);
    });
    tx.categoryTranslation.create.mockImplementation(() => {
      log.push('tx.categoryTranslation.create');
      return Promise.reject(new Error('slug conflict'));
    });

    const result = await service.importCategories([categoryDto()]);

    // Кейс краснеет не от позиции инкремента (`updated++` и раньше стоял после
    // `await this.upsertCategory`), а от строки ниже: любая запись через `root.`
    // означает, что вызов остался на `this.prisma` и откат его не заберёт.
    expect(result.updated).toBe(0);
    expect(result.errors).toEqual([{ key: 'victorian-literature', message: 'slug conflict' }]);
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(writesOf(log).filter((call) => call.startsWith('root.'))).toEqual([]);
  });

  it('пишет базовую строку, историю базового слага и оба перевода тега одним tx', async () => {
    const log: WriteLog = [];
    const { service, tx, $transaction } = makeService(log);

    // 🔴 `LEGACY-313`. Ветку выбирает чтение ВНУТРИ транзакции. Без этого мока
    // тест уходил бы в ветку создания: регрессия именно в ветке обновления
    // осталась бы непокрытой, а проверка `updated === 0` ниже зеленела бы
    // и на созданном теге.
    tx.tag.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('tx.tag.findUnique');
      return Promise.resolve(args?.where?.key === 'aestheticism' ? existingTag : null);
    });

    const result = await service.importTags([tagDto()]);

    expect(result).toEqual({ imported: 0, updated: 1, errors: [] });
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(writesOf(log)).toEqual([
      'tx.slugRedirect.recordBaseSlugChange',
      'tx.tag.update',
      'tx.slugRedirect.record',
      'tx.tagTranslation.update',
      'tx.tagTranslation.create',
    ]);
  });

  it('не считает тег обновлённым, если перевод упал на середине', async () => {
    const log: WriteLog = [];
    const { service, tx, $transaction } = makeService(log);

    // 🔴 `LEGACY-313`. Ветку выбирает чтение ВНУТРИ транзакции. Без этого мока
    // тест уходил бы в ветку создания: регрессия именно в ветке обновления
    // осталась бы непокрытой, а проверка `updated === 0` ниже зеленела бы
    // и на созданном теге.
    tx.tag.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('tx.tag.findUnique');
      return Promise.resolve(args?.where?.key === 'aestheticism' ? existingTag : null);
    });
    tx.tagTranslation.create.mockImplementation(() => {
      log.push('tx.tagTranslation.create');
      return Promise.reject(new Error('slug conflict'));
    });

    const result = await service.importTags([tagDto()]);

    expect(result.updated).toBe(0);
    expect(result.errors).toEqual([{ key: 'aestheticism', message: 'slug conflict' }]);
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(writesOf(log).filter((call) => call.startsWith('root.'))).toEqual([]);
  });
});

describe('ImportService — порядок родителей внутри партии (LEGACY-258)', () => {
  /**
   * Чтения категорий по ключу и по идентификатору.
   *
   * ⚠️ Один общий ответ на все чтения больше не годится: с 20.08.2026 привязка
   * родителя сверяет термин и родителя между собой (`LEGACY-263`, `LEGACY-264`),
   * и одинаковый `id` у обоих читается как «сам себе родитель». Ключи
   * раздаются в порядке создания — так же, как их раздаёт `tx.category.create`.
   */
  const readsByKey = (
    log: WriteLog,
    tx: { category: { findUnique: jest.Mock } },
    created: string[],
  ) =>
    tx.category.findUnique.mockImplementation((args: { where?: { key?: string; id?: string } }) => {
      log.push('tx.category.findUnique');
      const where = args?.where ?? {};
      if (where.key) {
        const index = created.indexOf(where.key);
        return Promise.resolve(
          index === -1 ? null : { id: `cat-${index + 1}`, type: CategoryType.genre },
        );
      }
      // Подъём по предкам: в этих партиях дерево ещё плоское, петель нет.
      return Promise.resolve({ parentId: null });
    });

  const child: ImportCategoryDto = {
    key: 'victorian-literature',
    type: CategoryType.genre,
    parentKey: 'classic-literature',
    translations: {
      [Language.en]: { name: 'Victorian Literature', slug: 'victorian-literature' },
    },
  } as ImportCategoryDto;

  const parent: ImportCategoryDto = {
    key: 'classic-literature',
    type: CategoryType.genre,
    translations: {
      [Language.en]: { name: 'Classic Literature', slug: 'classic-literature' },
    },
  } as ImportCategoryDto;

  it('создаёт родителя раньше ребёнка, даже если в файле ребёнок стоит первым', async () => {
    const log: WriteLog = [];
    const { service, tx } = makeService(log);

    const created: string[] = [];
    tx.category.create.mockImplementation((args: { data?: { key?: string } }) => {
      log.push('tx.category.create');
      created.push(args?.data?.key ?? '');
      return Promise.resolve({ id: `cat-${created.length}` });
    });
    readsByKey(log, tx, created);

    // Ребёнок записан выше родителя — ровно тот файл, который раньше давал
    // «успешный» импорт с термином, оставшимся в корне дерева.
    const result = await service.importCategories([child, parent]);

    expect(result).toEqual({ imported: 2, updated: 0, errors: [] });
    expect(created).toEqual(['classic-literature', 'victorian-literature']);
    expect(tx.category.update).toHaveBeenCalledWith({
      where: { key: 'victorian-literature' },
      data: { parentId: 'cat-1' },
    });
  });

  it('отбраковывает цикл внутри партии, не записав ни одного термина', async () => {
    const log: WriteLog = [];
    const { service } = makeService(log);

    const a = { ...parent, parentKey: 'victorian-literature' } as ImportCategoryDto;
    const result = await service.importCategories([child, a]);

    expect(result.imported).toBe(0);
    expect(result.errors.map((e) => e.key).sort()).toEqual([
      'classic-literature',
      'victorian-literature',
    ]);
    expect(writesOf(log)).toEqual([]);
  });

  it('держит порядок на глубине три и на нескольких детях одного родителя', async () => {
    const log: WriteLog = [];
    const { service, tx } = makeService(log);

    const created: string[] = [];
    tx.category.create.mockImplementation((args: { data?: { key?: string } }) => {
      log.push('tx.category.create');
      created.push(args?.data?.key ?? '');
      return Promise.resolve({ id: `cat-${created.length}` });
    });
    readsByKey(log, tx, created);

    const node = (key: string, parentKey?: string): ImportCategoryDto =>
      ({
        key,
        type: CategoryType.genre,
        parentKey,
        translations: { [Language.en]: { name: `Name ${key}`, slug: key } },
      }) as ImportCategoryDto;

    // Дед → родитель → двое внуков, и всё это записано в файле задом наперёд.
    // Обход, теряющий второго ребёнка одного родителя, отправил бы его в `errors`;
    // обход, кладущий детей мимо очереди, объявил бы внука циклом.
    const result = await service.importCategories([
      node('grandchild-b', 'child'),
      node('grandchild-a', 'child'),
      node('child', 'root-genre'),
      node('root-genre'),
    ]);

    expect(result).toEqual({ imported: 4, updated: 0, errors: [] });
    expect(created.slice(0, 2)).toEqual(['root-genre', 'child']);
    expect(created.slice(2).sort()).toEqual(['grandchild-a', 'grandchild-b']);
  });

  it('не теряет молча элемент с повторённым ключом', async () => {
    const log: WriteLog = [];
    const { service } = makeService(log);

    const twin: ImportCategoryDto = {
      key: 'victorian-literature',
      type: CategoryType.genre,
      translations: { [Language.en]: { name: 'Twin', slug: 'twin' } },
    } as ImportCategoryDto;

    const result = await service.importCategories([parent, twin, twin]);

    // Отчёт обязан сходиться: сколько элементов пришло, столько и разобрано.
    expect(result.imported + result.updated + result.errors.length).toBe(3);
    expect(result.errors).toEqual([
      {
        key: 'victorian-literature',
        message: 'duplicate key "victorian-literature" inside the batch',
      },
    ]);
  });

  it('валит термин с ошибкой, если родителя нет в базе к моменту записи', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);

    // Родитель есть в базе на предварительной проверке...
    root.category.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('root.category.findUnique');
      return Promise.resolve(args?.where?.key === 'classic-literature' ? { id: 'parent-1' } : null);
    });
    // ...но к моменту записи его уже нет. Раньше это молча давало термин без
    // родителя и всё равно шло в `imported`.
    tx.category.findUnique.mockImplementation(() => {
      log.push('tx.category.findUnique');
      return Promise.resolve(null);
    });

    const result = await service.importCategories([child]);

    expect(result.imported).toBe(0);
    expect(result.errors).toEqual([
      { key: 'victorian-literature', message: 'parentKey "classic-literature" not found' },
    ]);
  });
});

/**
 * Импорт не имеет права замкнуть дерево категорий (`LEGACY-263`) и подвесить
 * термин под родителя другого типа (`LEGACY-264`).
 *
 * Обе дыры были одной природы: `orderByParent` видит рёбра **только внутри
 * партии**, а родитель, взятый из базы, проверялся ровно на одно условие —
 * существует. Административный путь (`CategoryService.update`) те же две связи
 * отвергает четырьмястами, и расхождение наблюдалось так: `POST /import/categories`
 * с `{ key: "classic-literature", parentKey: "victorian-literature" }`, где
 * victorian уже потомок classic, проходил целиком, после чего
 * `GET /categories/{id}/ancestors` не отвечал **никогда**.
 *
 * ⚠️ Кейсы смотрят не только на текст отказа, но и на **отсутствие записи**:
 * проверка, которая ругается после `category.update`, дерево уже замкнула.
 */
describe('ImportService — родитель из базы проверяется, а не только находится', () => {
  /**
   * Термин и родитель уже лежат в базе, родитель — потомок термина.
   * `parent-of-child` задаёт `parentId` родителя, по которому идёт подъём.
   */
  const closedTree = (
    log: WriteLog,
    tx: { category: { findUnique: jest.Mock } },
    opts: { parentType?: CategoryType; parentParentId?: string | null } = {},
  ) => {
    const { parentType = CategoryType.genre, parentParentId = null } = opts;
    tx.category.findUnique.mockImplementation((args: { where?: { key?: string; id?: string } }) => {
      log.push('tx.category.findUnique');
      const where = args?.where ?? {};
      if (where.key === 'classic-literature')
        return Promise.resolve({
          id: 'cat-classic',
          type: CategoryType.genre,
          parentId: null,
          translations: [],
        });
      if (where.key === 'victorian-literature')
        return Promise.resolve({
          id: 'cat-victorian',
          type: parentType,
          parentId: null,
          translations: [],
        });
      if (where.id === 'cat-victorian') return Promise.resolve({ parentId: parentParentId });
      if (where.id === 'cat-classic') return Promise.resolve({ parentId: null });
      return Promise.resolve(null);
    });
  };

  const classicWithParent = (): ImportCategoryDto =>
    ({
      key: 'classic-literature',
      type: CategoryType.genre,
      parentKey: 'victorian-literature',
      translations: {
        [Language.en]: { name: 'Classic Literature', slug: 'classic-literature' },
      },
    }) as ImportCategoryDto;

  it('отказывает по ключу термина, когда родитель из базы — его потомок (LEGACY-263)', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);

    root.category.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('root.category.findUnique');
      // Предварительная проверка находит родителя, термин уже существует.
      return Promise.resolve(
        args?.where?.key === 'victorian-literature'
          ? { id: 'cat-victorian' }
          : { id: 'cat-classic', translations: [] },
      );
    });
    // victorian — потомок classic: подъём от него встречает cat-classic.
    closedTree(log, tx, { parentParentId: 'cat-classic' });

    const result = await service.importCategories([classicWithParent()]);

    expect(result.imported).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.errors).toEqual([
      { key: 'classic-literature', message: 'Cycle detected in category hierarchy' },
    ]);
    // Дерево не замкнулось: `parentId` не записан ни разу.
    expect(
      tx.category.update.mock.calls.filter(
        (call) => (call[0] as { data?: { parentId?: unknown } })?.data?.parentId !== undefined,
      ),
    ).toEqual([]);
  });

  it('отказывает, когда тип родителя не совпадает с типом термина (LEGACY-264)', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);

    root.category.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('root.category.findUnique');
      return Promise.resolve(
        args?.where?.key === 'victorian-literature'
          ? { id: 'cat-victorian' }
          : { id: 'cat-classic', translations: [] },
      );
    });
    // Родитель — коллекция, импортируемый термин — жанр.
    closedTree(log, tx, { parentType: CategoryType.collection });

    const result = await service.importCategories([classicWithParent()]);

    expect(result.imported).toBe(0);
    expect(result.errors).toEqual([
      {
        key: 'classic-literature',
        message: 'Parent category type mismatch: parent and child must have the same type',
      },
    ]);
    expect(
      tx.category.update.mock.calls.filter(
        (call) => (call[0] as { data?: { parentId?: unknown } })?.data?.parentId !== undefined,
      ),
    ).toEqual([]);
  });

  it('пропускает законного родителя того же типа, не являющегося потомком', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);

    root.category.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('root.category.findUnique');
      return Promise.resolve(
        args?.where?.key === 'victorian-literature'
          ? { id: 'cat-victorian' }
          : { id: 'cat-classic', translations: [] },
      );
    });
    closedTree(log, tx, { parentParentId: null });

    const result = await service.importCategories([classicWithParent()]);

    expect(result.errors).toEqual([]);
    expect(result.updated).toBe(1);
    expect(tx.category.update).toHaveBeenCalledWith({
      where: { key: 'classic-literature' },
      data: { parentId: 'cat-victorian' },
    });
  });
});

/**
 * Развилка «создание или обновление» и всё, что из неё берётся, принимаются
 * ВНУТРИ транзакции, под уже взятой блокировкой (`LEGACY-304`, `LEGACY-312`).
 *
 * ⚠️ Строка на пуле и строка в транзакции здесь намеренно РАЗНЫЕ. Спека, где
 * они совпадают, зеленеет и на дефекте: пока обе отдают одно и то же, нельзя
 * сказать, какую из них прочитал код.
 */
describe('ImportService — решение о записи принимается под блокировкой', () => {
  const existingInTx = {
    id: 'cat-1',
    type: CategoryType.genre,
    parentId: null,
    indexable: true,
    isVisible: true,
    sortOrder: 42,
    translations: [],
  };

  it('термин, появившийся между чтением на пуле и транзакцией, обновляется, а не заводится заново (LEGACY-312)', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);

    // Пул: термина нет — ровно то состояние, из которого прежний код уходил
    // в ветку создания и получал `P2002` по ключу.
    root.category.findUnique.mockImplementation(() => {
      log.push('root.category.findUnique');
      return Promise.resolve(null);
    });
    // Транзакция: термин уже есть — его завёл встречный импорт.
    tx.category.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('tx.category.findUnique');
      return Promise.resolve(args?.where?.key === 'victorian-literature' ? existingInTx : null);
    });

    const result = await service.importCategories([categoryDto()]);

    expect(result).toEqual({ imported: 0, updated: 1, errors: [] });
    expect(tx.category.create).not.toHaveBeenCalled();
    expect(tx.category.update).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠️ Прежде эта проверка стояла на дефолте `sortOrder`: на пуле лежало
   * устаревшее значение, в транзакции — свежее, и запись обязана была взять
   * второе. `LEGACY-322` убрала чтение дефолтов вовсе, и вместе с ним ушёл этот
   * способ различить два клиента. Гарантия `LEGACY-304` при этом осталась —
   * `existing` по-прежнему читается в транзакции и по-прежнему решает, сменился
   * ли тип, — поэтому различитель взят оттуда, а проверка не снята. Тот же ход
   * и по той же причине сделан у тега при закрытии `LEGACY-318`
   * (блок `LEGACY-313`, «базовый слаг сверяется со строкой транзакции»).
   */
  it('смена типа считается по строке транзакции, а не по чтению на пуле (LEGACY-304)', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);

    // Пул: тип уже такой же, как в файле, — по нему смены типа нет вовсе
    // и край ребра «вниз» никто бы не проверил.
    root.category.findUnique.mockImplementation(() => {
      log.push('root.category.findUnique');
      return Promise.resolve({ ...existingInTx, type: CategoryType.genre });
    });
    // Транзакция: тип ещё прежний — значит смена настоящая, и проверка детей
    // обязана состояться.
    tx.category.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('tx.category.findUnique');
      return Promise.resolve(
        args?.where?.key === 'victorian-literature'
          ? { ...existingInTx, type: CategoryType.category }
          : null,
      );
    });

    await service.importCategories([categoryDto()]);

    expect(tx.category.update).toHaveBeenCalledTimes(1);
    // `assertChildTypesAllowed` спрашивает базу об одном несовпадающем ребёнке
    // и запускается только при сменившемся типе (`category-tree.service.ts:335`).
    expect(tx.category.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.category.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          parentId: 'cat-1',
          type: { not: CategoryType.genre },
        }),
      }),
    );
  });
});

/**
 * 🔴 `LEGACY-313`. Тег повторял `LEGACY-304` и `LEGACY-312` целиком: развилка
 * «создание или обновление» и дефолты брались из чтения на пуле, а счётчик
 * отчёта — из второго такого же чтения.
 *
 * ⚠️ Приём тот же, что в блоке про категории выше: `root.tag.findUnique`
 * и `tx.tag.findUnique` мокаются **по-разному** и расходятся ровно в том, что
 * проверяется. Спека на одном клиенте здесь бесполезна — она зеленела и на
 * чтении с пула.
 */
describe('ImportService — решение о записи тега принимается в транзакции (LEGACY-313)', () => {
  const existingInTx = {
    id: 'tag-1',
    key: 'aestheticism',
    slug: 'aestheticism',
    indexable: true,
    isVisible: true,
    sortOrder: 42,
    translations: [],
  };

  it('тег, появившийся между чтением на пуле и транзакцией, обновляется, а не заводится заново', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);

    // Пул: тега нет — то состояние, из которого прежний код уходил в ветку
    // создания и получал `P2002` по ключу.
    root.tag.findUnique.mockImplementation(() => {
      log.push('root.tag.findUnique');
      return Promise.resolve(null);
    });
    // Транзакция: тег уже есть — его завёл встречный импорт.
    tx.tag.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('tx.tag.findUnique');
      return Promise.resolve(args?.where?.key === 'aestheticism' ? existingInTx : null);
    });

    const result = await service.importTags([tagDto()]);

    expect(result).toEqual({ imported: 0, updated: 1, errors: [] });
    expect(tx.tag.create).not.toHaveBeenCalled();
    expect(tx.tag.update).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠️ Прежде эта проверка стояла на дефолте `sortOrder`: на пуле лежало
   * устаревшее значение, в транзакции — свежее, и запись обязана была взять
   * второе. `LEGACY-318` убрала чтение дефолтов вовсе, и вместе с ним ушёл
   * этот способ различить два клиента. Гарантия `LEGACY-313` при этом
   * осталась — `existing` по-прежнему читается в транзакции и по-прежнему
   * решает, писать ли историю базового слага, — поэтому различитель взят
   * оттуда, а проверка не снята.
   */
  it('базовый слаг сверяется со строкой транзакции, а не с чтением на пуле', async () => {
    const log: WriteLog = [];
    const { service, root, tx, slugRedirects } = makeService(log);

    // Пул: слаг уже совпадает с файлом — по нему истории не было бы вовсе.
    root.tag.findUnique.mockImplementation(() => {
      log.push('root.tag.findUnique');
      return Promise.resolve(existingInTx);
    });
    // Транзакция: слаг ещё старый — значит смена настоящая и её надо записать.
    tx.tag.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('tx.tag.findUnique');
      return Promise.resolve(
        args?.where?.key === 'aestheticism' ? { ...existingInTx, slug: 'old-in-tx' } : null,
      );
    });

    await service.importTags([tagDto()]);

    expect(slugRedirects.recordBaseSlugChange).toHaveBeenCalledTimes(1);
    expect(slugRedirects.recordBaseSlugChange).toHaveBeenCalledWith(
      'tag',
      'old-in-tx',
      'aestheticism',
      tx,
    );
  });

  it('счётчик отчёта считается по транзакции: тег, которого нет нигде, засчитывается созданным', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);

    // Пул врёт в другую сторону: «тег есть». Прежний код по нему засчитал бы
    // `updated`, хотя транзакция завела новый.
    root.tag.findUnique.mockImplementation(() => {
      log.push('root.tag.findUnique');
      return Promise.resolve(existingInTx);
    });
    tx.tag.findUnique.mockImplementation(() => {
      log.push('tx.tag.findUnique');
      return Promise.resolve(null);
    });

    const result = await service.importTags([tagDto()]);

    expect(result).toEqual({ imported: 1, updated: 0, errors: [] });
    expect(tx.tag.create).toHaveBeenCalledTimes(1);
    expect(tx.tag.update).not.toHaveBeenCalled();
  });

  it('список переводов берётся из строки транзакции: перевод, которого в ней нет, заводится, а не обновляется', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);

    // На пуле у тега уже есть английский перевод — по этой строке прежний код
    // ушёл бы в `tagTranslation.update` по несуществующей строке и получил `P2025`.
    root.tag.findUnique.mockImplementation(() => {
      log.push('root.tag.findUnique');
      return Promise.resolve({
        ...existingInTx,
        translations: [
          { id: 'tt-en', tagId: 'tag-1', language: Language.en, slug: 'aestheticism' },
        ],
      });
    });
    // В транзакции переводов нет: встречный импорт их ещё не завёл либо откатился.
    tx.tag.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('tx.tag.findUnique');
      return Promise.resolve(args?.where?.key === 'aestheticism' ? existingInTx : null);
    });

    await service.importTags([tagDto()]);

    expect(tx.tagTranslation.update).not.toHaveBeenCalled();
    expect(tx.tagTranslation.create).toHaveBeenCalledTimes(2);
  });
});

/**
 * 🔴 `LEGACY-318`. Импорт брал дефолты из строки, прочитанной в транзакции:
 * `indexable: dto.indexable ?? existing.indexable` и так три поля. Файл импорта
 * их не называет — значит в `UPDATE` уходило значение из снимка, и админский
 * `PATCH /tags/:id {"isVisible": false}`, закоммитившийся между чтением
 * и записью, затирался молча: тег снова публичный, в отчёте `updated: 1`,
 * `errors` пуст.
 *
 * ⚠️ Гонку здесь проверяет не параллельный прогон, а **форма запроса**: после
 * правки столбец не читается вовсе, поэтому затирать нечем, и доказывать надо
 * именно отсутствие ключа в `data`, а не исход двух транзакций. E2E на живом
 * Postgres был бы доказательством отсутствия события, а не поведения.
 *
 * ⚠️ Проверка `not.toHaveProperty` по одному полю зеленела бы и на опечатке
 * в имени поля, поэтому рядом стоит положительный случай: переданное значение
 * обязано доехать. Два теста стерегут две стороны одной правки.
 */
describe('ImportService — импорт не переписывает поля, которых нет в файле (LEGACY-318)', () => {
  const existingInTx = {
    id: 'tag-1',
    key: 'aestheticism',
    slug: 'aestheticism',
    indexable: false,
    isVisible: false,
    sortOrder: 42,
    translations: [],
  };

  const seed = (log: WriteLog, root: FakeClient, tx: FakeClient) => {
    root.tag.findUnique.mockImplementation(() => {
      log.push('root.tag.findUnique');
      return Promise.resolve(existingInTx);
    });
    tx.tag.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('tx.tag.findUnique');
      return Promise.resolve(args?.where?.key === 'aestheticism' ? existingInTx : null);
    });
  };

  const dataOfUpdate = (tx: FakeClient): Record<string, unknown> => {
    const calls = tx.tag.update.mock.calls as Array<[{ data: Record<string, unknown> }]>;
    expect(calls).toHaveLength(1);
    return calls[0][0].data;
  };

  it('поле, не названное в файле, в UPDATE не попадает вовсе', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);
    seed(log, root, tx);

    // В `tagDto()` нет ни `indexable`, ни `isVisible`, ни `sortOrder`.
    await service.importTags([tagDto()]);

    const data = dataOfUpdate(tx);
    expect(data).not.toHaveProperty('indexable');
    expect(data).not.toHaveProperty('isVisible');
    expect(data).not.toHaveProperty('sortOrder');
    // Страховка от «проверено ноль полей»: то, что файл называет, доехать обязано.
    expect(data).toMatchObject({ name: 'Aestheticism', slug: 'aestheticism' });
  });

  it('поле, названное в файле, доезжает до UPDATE со своим значением', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);
    seed(log, root, tx);

    await service.importTags([
      { ...tagDto(), indexable: true, isVisible: true, sortOrder: 7 } as ImportTagDto,
    ]);

    expect(dataOfUpdate(tx)).toMatchObject({ indexable: true, isVisible: true, sortOrder: 7 });
  });

  /**
   * 🔴 Найдено ревью `books-data` 30.08.2026, до коммита. Строгое `!== undefined`
   * считало бы переданным и явный `null`: `@IsOptional()` в `ImportTagDto`
   * пропускает `null` наравне с `undefined`, а `ValidationPipe` объявленное поле
   * со значением `null` не вырезает. Все три столбца `NOT NULL`, поэтому `null`
   * в `data` уронил бы Prisma и откатил всю транзакцию термина — вместе
   * с переводами и редиректом слага. Прежний `dto.X ?? existing.X` такой файл
   * принимал, и потерять это было бы регрессией, а не закрытием записи.
   */
  it('явный null в файле считается «поле не задано», а не значением', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);
    seed(log, root, tx);

    const result = await service.importTags([
      { ...tagDto(), isVisible: null, sortOrder: null } as unknown as ImportTagDto,
    ]);

    const data = dataOfUpdate(tx);
    expect(data).not.toHaveProperty('isVisible');
    expect(data).not.toHaveProperty('sortOrder');
    // Термин обязан пройти целиком: транзакция не откатывается.
    expect(result).toEqual({ imported: 0, updated: 1, errors: [] });
  });

  it('переданным считается и явный false: он не теряется как «не задано»', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);
    seed(log, root, tx);

    await service.importTags([{ ...tagDto(), isVisible: false, sortOrder: 0 } as ImportTagDto]);

    const data = dataOfUpdate(tx);
    expect(data).toMatchObject({ isVisible: false, sortOrder: 0 });
    expect(data).not.toHaveProperty('indexable');
  });
});

/**
 * 🔴 `LEGACY-320`, третий пункт. Отказ `P2025` из транзакции термина означает,
 * что строку удалили между тем, как её увидел этот импорт, и тем, как он в неё
 * написал. Замок строки тега такое не закрывает и закрыть не может:
 * `TagsService.remove` ходит вообще без транзакции, а переводы адресуются парой
 * `(tagId, language)` и запираются не строкой `Tag` (`LEGACY-360`).
 *
 * ⚠️ Проверяется **диагноз**, а не факт строки в отчёте. Прежде `P2025` уходил
 * общей веткой и печатался сырым текстом Prisma: оператор читал сообщение про
 * неизвестную запись и шёл искать ошибку в своём файле, которой там нет.
 * Совет «запусти заново» здесь верен, а прежний диагноз — нет.
 *
 * ⚠️ Рядом стоит `P2002`: две ветки одного `catch` обязаны остаться разными.
 * Проверка одной из них зеленела бы и на схлопывании обеих в общий текст.
 */
describe('ImportService — отказ по удалённой в окне строке назван своей причиной (LEGACY-320)', () => {
  const prismaError = (code: string) => {
    const err = new Error(`Prisma error ${code}`) as Error & { code: string };
    err.code = code;
    return err;
  };

  const seedExisting = (log: WriteLog, root: FakeClient, tx: FakeClient) => {
    const existing = {
      id: 'tag-1',
      key: 'aestheticism',
      slug: 'aestheticism',
      indexable: true,
      isVisible: true,
      sortOrder: 0,
      translations: [],
    };
    const answer = (args: { where?: { key?: string } }) =>
      Promise.resolve(args?.where?.key === 'aestheticism' ? existing : null);
    root.tag.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('root.tag.findUnique');
      return answer(args);
    });
    tx.tag.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('tx.tag.findUnique');
      return answer(args);
    });
  };

  it('P2025 говорит про удаление в окне импорта, а не печатает сырой текст Prisma', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);
    seedExisting(log, root, tx);
    tx.tag.update.mockImplementation(() => Promise.reject(prismaError('P2025')));

    const result = await service.importTags([tagDto()]);

    expect(result).toMatchObject({ imported: 0, updated: 0 });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].key).toBe('aestheticism');
    expect(result.errors[0].message).toContain('was removed while it was being imported');
    // Диагноз обязан называть обе причины: `P2025` бросает и `tx.tag.update`,
    // и `tx.tagTranslation.update`. Названная одна отправила бы оператора
    // проверять тег, который на месте.
    expect(result.errors[0].message).toContain('translations');
    expect(result.errors[0].message).not.toContain('Prisma error');
  });

  it('P2002 остаётся своей веткой и своим текстом', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);
    seedExisting(log, root, tx);
    tx.tag.update.mockImplementation(() => Promise.reject(prismaError('P2002')));

    const result = await service.importTags([tagDto()]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('Duplicate key');
    expect(result.errors[0].message).not.toContain('was removed');
  });

  /**
   * ⚠️ `LEGACY-131`: категории и теги правятся вместе, иначе второй метод
   * остаётся образцом для копирования. Здесь случай достижим не вопреки
   * блокировке дерева, а мимо неё: `CategoryService.deleteTranslation` идёт
   * голой `$transaction` **без** `runInLockedTree`, поэтому `P2025`
   * на `tx.categoryTranslation.update` возможен при живом термине.
   */
  it('у категории P2025 назван так же, а не сырым текстом Prisma', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);
    const existing = {
      id: 'cat-1',
      key: 'victorian-literature',
      type: CategoryType.genre,
      slug: 'victorian-literature',
      parentId: null,
      indexable: true,
      isVisible: true,
      sortOrder: 0,
      translations: [],
    };
    const answer = (args: { where?: { key?: string } }) =>
      Promise.resolve(args?.where?.key === existing.key ? existing : null);
    root.category.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('root.category.findUnique');
      return answer(args);
    });
    tx.category.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('tx.category.findUnique');
      return answer(args);
    });
    tx.category.update.mockImplementation(() => Promise.reject(prismaError('P2025')));

    const result = await service.importCategories([categoryDto()]);

    expect(result).toMatchObject({ imported: 0, updated: 0 });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].key).toBe('victorian-literature');
    expect(result.errors[0].message).toContain('was removed while it was being imported');
    expect(result.errors[0].message).toContain('translations');
    expect(result.errors[0].message).not.toContain('Prisma error');
  });

  it('прочие отказы по-прежнему уходят своим текстом, а не подводятся под P2025', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);
    seedExisting(log, root, tx);
    tx.tag.update.mockImplementation(() => Promise.reject(new Error('connection reset')));

    const result = await service.importTags([tagDto()]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe('connection reset');
  });
});

/**
 * 🔴 `LEGACY-323`. Глобальный `ValidationPipe` на маршрутах импорта не запускал
 * ни одного валидатора: metatype параметра `@Body() dto: T[]` равен `Array`,
 * а `Array` стоит в списке типов, которые пайп пропускает без проверки. Все
 * декораторы `ImportTagDto` и `ImportCategoryDto` были мертвы — слаг любой
 * формы, число вместо строки, отрицательный `sortOrder` и лишние поля доезжали
 * до записи, а оператор получал 201 и `errors: []`.
 *
 * ⚠️ Проверка **поэлементная**, а не на всю партию, и это не деталь реализации:
 * ручки импорта устроены как частичный успех (`LEGACY-315`), и `ParseArrayPipe`
 * отверг бы четырёхсотым файл в тысячу терминов из-за одной битой строки.
 * Решение арбитра от 03.09.2026. Поэтому ниже всюду проверяется пара «негодный
 * назван в `errors` — годный записан», а не один только отказ.
 */
describe('ImportService — тело партии проверяется поэлементно (LEGACY-323)', () => {
  const seedEmpty = (log: WriteLog, root: FakeClient, tx: FakeClient) => {
    const empty = (label: 'root' | 'tx', model: 'category' | 'tag') =>
      jest.fn().mockImplementation(() => {
        log.push(`${label}.${model}.findUnique`);
        return Promise.resolve(null);
      });
    root.category.findUnique = empty('root', 'category');
    tx.category.findUnique = empty('tx', 'category');
    root.tag.findUnique = empty('root', 'tag');
    tx.tag.findUnique = empty('tx', 'tag');
  };

  it('негодный слаг тега назван в errors, а годный сосед импортируется', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);
    seedEmpty(log, root, tx);

    const result = await service.importTags([
      { ...tagDto(), key: 'broken', slug: 'Не Слаг!' } as ImportTagDto,
      { ...tagDto(), key: 'fine', slug: 'fine' } as ImportTagDto,
    ]);

    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].key).toBe('broken');
    expect(result.errors[0].message).not.toHaveLength(0);
    expect(tx.tag.create).toHaveBeenCalledTimes(1);
  });

  it('отрицательный sortOrder не доезжает до записи', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);
    seedEmpty(log, root, tx);

    const result = await service.importTags([
      { ...tagDto(), sortOrder: -1 } as unknown as ImportTagDto,
    ]);

    expect(result).toMatchObject({ imported: 0, updated: 0 });
    expect(result.errors).toHaveLength(1);
    expect(tx.tag.create).not.toHaveBeenCalled();
  });

  it('лишнее поле в элементе отвергается, а не уезжает дальше в объекте', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);
    seedEmpty(log, root, tx);

    const result = await service.importCategories([
      { ...categoryDto(), somethingElse: 1 } as unknown as ImportCategoryDto,
    ]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].key).toBe('victorian-literature');
    expect(tx.category.create).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ Ключ строки отчёта у элемента с негодным `key` брать неоткуда: назвать
   * его ключом термина значило бы напечатать в отчёте то самое значение,
   * которое отвергнуто. Поэтому ключ служебный, с позицией в присланной партии —
   * только по ней оператор найдёт строку в своём файле.
   */
  it('элемент без годного ключа назван позицией в партии, а не пустой строкой', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);
    seedEmpty(log, root, tx);

    const broken = { ...tagDto() } as Partial<ImportTagDto>;
    delete broken.key;

    const result = await service.importTags([
      { ...tagDto(), key: 'fine' } as ImportTagDto,
      broken as ImportTagDto,
    ]);

    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].key).toBe('(item 1)');
  });

  /**
   * ⚠️ Единственный вход, отвечающий 400: отчёта по элементам тут не существует.
   * Прежде здесь был 500 — `for...of` по объекту бросает `TypeError` мимо любого
   * `catch` ручки.
   */
  it('тело, которое вовсе не массив, отвергается четырёхсотым, а не роняет ручку', async () => {
    const log: WriteLog = [];
    const { service } = makeService(log);

    await expect(
      service.importTags({ tags: [] } as unknown as ImportTagDto[]),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.importCategories(null as unknown as ImportCategoryDto[]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  /**
   * ⚠️ Страховка от «проверено ноль правил»: годная партия обязана пройти
   * насквозь. Без этого теста любая ошибка в опциях валидатора — например
   * `forbidNonWhitelisted` на объекте с необъявленным полем перевода —
   * зеленела бы, отвергая вообще всё.
   */
  /**
   * 🔴 Найдено ревью 03.09.2026, до коммита, — дефект внесла сама правка.
   * `plainToInstance` на `null`, числе или строке возвращает то же значение
   * без изменений, а `validateSync` разыменовывает у него `constructor`.
   * Партия `[null, {годный тег}]` роняла ручку `TypeError` мимо всякого
   * `catch` — то есть отказом «всё или ничего», ради отмены которого
   * `ParseArrayPipe` и был отклонён.
   */
  it('элемент, который не объект, называется строкой в errors, а не роняет партию', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);
    seedEmpty(log, root, tx);

    const result = await service.importTags([
      null as unknown as ImportTagDto,
      { ...tagDto(), key: 'fine' } as ImportTagDto,
      42 as unknown as ImportTagDto,
      ['nested'] as unknown as ImportTagDto,
    ]);

    expect(result.imported).toBe(1);
    expect(result.errors.map((e) => e.key)).toEqual(['(item 0)', '(item 2)', '(item 3)']);
    expect(tx.tag.create).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠️ Партия из одного негодного элемента обязана пройти так же: ручка
   * отвечает 201 с отчётом, а не 500. Отдельным тестом потому, что первый
   * зеленел бы и на «упало после годного соседа».
   */
  it('партия из одного null проходит целиком и отдаёт отчёт, а не отказ', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);
    seedEmpty(log, root, tx);

    await expect(service.importCategories([null as unknown as ImportCategoryDto])).resolves.toEqual(
      {
        imported: 0,
        updated: 0,
        errors: [{ key: '(item 0)', message: 'Item must be a JSON object' }],
      },
    );
  });

  it('годная партия проходит целиком и ни одной строки в errors не даёт', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);
    seedEmpty(log, root, tx);

    const tags = await service.importTags([tagDto()]);
    const categories = await service.importCategories([categoryDto()]);

    expect(tags).toEqual({ imported: 1, updated: 0, errors: [] });
    expect(categories).toEqual({ imported: 1, updated: 0, errors: [] });
  });
});

/**
 * 🔴 `LEGACY-322`. Тот же дефект, что `LEGACY-318` закрыла у тега, оставался
 * в соседнем методе того же файла: `upsertCategory` писал
 * `indexable: dto.indexable ?? existing.indexable` и так три поля. Файл импорта
 * их не называет — значит в `UPDATE` уходило значение из снимка, и админский
 * `PATCH /categories/:id {"isVisible": false}`, закоммитившийся между чтением
 * и записью, затирался молча: категория снова на витрине, в отчёте `updated: 1`,
 * `errors` пуст.
 *
 * ⚠️ Проверяется **форма запроса**, а не исход двух транзакций: после правки
 * столбец не читается вовсе, поэтому затирать нечем. Доказывать надо отсутствие
 * ключа в `data`. Рядом стоит положительный случай — иначе `not.toHaveProperty`
 * зеленел бы и на опечатке в имени поля.
 *
 * ⚠️ Сравнение нестрогое (`!= null`), как у тега: `@IsOptional()` пропускает
 * `null` наравне с `undefined`, все три столбца `Category` — `NOT NULL`,
 * и строгое `!== undefined` отправило бы `null` в Prisma и уронило бы всю
 * транзакцию термина вместе с переводами.
 */
describe('ImportService — импорт категории не переписывает поля, которых нет в файле (LEGACY-322)', () => {
  const existingInTx = {
    id: 'cat-1',
    key: 'victorian-literature',
    type: CategoryType.genre,
    slug: 'victorian-literature',
    parentId: null,
    indexable: false,
    isVisible: false,
    sortOrder: 42,
    translations: [],
  };

  const seed = (log: WriteLog, root: FakeClient, tx: FakeClient) => {
    const answer = (args: { where?: { key?: string } }) =>
      Promise.resolve(args?.where?.key === existingInTx.key ? existingInTx : null);
    root.category.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('root.category.findUnique');
      return answer(args);
    });
    tx.category.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('tx.category.findUnique');
      return answer(args);
    });
  };

  const dataOfUpdate = (tx: FakeClient): Record<string, unknown> => {
    const calls = tx.category.update.mock.calls as Array<[{ data: Record<string, unknown> }]>;
    expect(calls).toHaveLength(1);
    return calls[0][0].data;
  };

  it('поле, не названное в файле, в UPDATE не попадает вовсе', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);
    seed(log, root, tx);

    // В `categoryDto()` нет ни `indexable`, ни `isVisible`, ни `sortOrder`.
    await service.importCategories([categoryDto()]);

    const data = dataOfUpdate(tx);
    expect(data).not.toHaveProperty('indexable');
    expect(data).not.toHaveProperty('isVisible');
    expect(data).not.toHaveProperty('sortOrder');
    // Страховка от «проверено ноль полей»: то, что файл называет, доехать обязано.
    expect(data).toMatchObject({ type: CategoryType.genre, name: 'Victorian Literature' });
  });

  it('поле, названное в файле, доезжает до UPDATE со своим значением', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);
    seed(log, root, tx);

    await service.importCategories([
      { ...categoryDto(), indexable: true, isVisible: true, sortOrder: 7 } as ImportCategoryDto,
    ]);

    expect(dataOfUpdate(tx)).toMatchObject({ indexable: true, isVisible: true, sortOrder: 7 });
  });

  it('явный null в файле считается «поле не задано», а не значением', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);
    seed(log, root, tx);

    const result = await service.importCategories([
      { ...categoryDto(), isVisible: null, sortOrder: null } as unknown as ImportCategoryDto,
    ]);

    const data = dataOfUpdate(tx);
    expect(data).not.toHaveProperty('isVisible');
    expect(data).not.toHaveProperty('sortOrder');
    // Термин обязан пройти целиком: транзакция не откатывается.
    expect(result).toEqual({ imported: 0, updated: 1, errors: [] });
  });

  it('переданным считается и явный false: он не теряется как «не задано»', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);
    seed(log, root, tx);

    await service.importCategories([
      { ...categoryDto(), isVisible: false, sortOrder: 0 } as ImportCategoryDto,
    ]);

    const data = dataOfUpdate(tx);
    expect(data).toMatchObject({ isVisible: false, sortOrder: 0 });
    expect(data).not.toHaveProperty('indexable');
  });
});

/**
 * 🔴 `LEGACY-308`. Тип пишется безусловно, а проверка родителя стояла под
 * `if (dto.parentKey !== undefined)`: условие зависело от наличия поля в файле
 * импорта, а не от того, меняется ли что-то из пары «родитель, тип».
 *
 * 🔴 `LEGACY-303`, тот же путь: у термина, сменившего тип, остаются дети
 * прежнего типа.
 */
describe('ImportService — смена типа проверяет оба края ребра', () => {
  const typedDto = (): ImportCategoryDto =>
    ({
      key: 'victorian-literature',
      // Тип в файле сменился, `parentKey` не назван вовсе.
      type: CategoryType.collection,
      translations: {
        [Language.en]: { name: 'Victorian Literature', slug: 'victorian-literature' },
      },
    }) as ImportCategoryDto;

  const existingUnderParent = {
    id: 'cat-1',
    type: CategoryType.genre,
    parentId: 'cat-parent',
    indexable: true,
    isVisible: true,
    sortOrder: 0,
    translations: [],
  };

  it('отказывает, когда сменённый тип не совпадает с типом фактического родителя (LEGACY-308)', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);

    root.category.findUnique.mockImplementation(() => {
      log.push('root.category.findUnique');
      return Promise.resolve(existingUnderParent);
    });
    tx.category.findUnique.mockImplementation((args: { where?: { key?: string; id?: string } }) => {
      log.push('tx.category.findUnique');
      const where = args?.where ?? {};
      if (where.key === 'victorian-literature') return Promise.resolve(existingUnderParent);
      // Родитель остался жанром, а термин стал коллекцией.
      if (where.id === 'cat-parent')
        return Promise.resolve({ id: 'cat-parent', type: CategoryType.genre });
      return Promise.resolve(null);
    });

    const result = await service.importCategories([typedDto()]);

    expect(result.updated).toBe(0);
    expect(result.errors).toEqual([
      {
        key: 'victorian-literature',
        message: 'Parent category type mismatch: parent and child must have the same type',
      },
    ]);
  });

  it('отказывает, когда у сменившего тип термина остаются дети прежнего типа (LEGACY-303)', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);

    const rootTerm = { ...existingUnderParent, parentId: null };
    root.category.findUnique.mockImplementation(() => {
      log.push('root.category.findUnique');
      return Promise.resolve(rootTerm);
    });
    tx.category.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('tx.category.findUnique');
      return Promise.resolve(args?.where?.key === 'victorian-literature' ? rootTerm : null);
    });
    tx.category.findFirst.mockResolvedValue({ id: 'child-1', type: CategoryType.genre });

    const result = await service.importCategories([typedDto()]);

    expect(result.updated).toBe(0);
    expect(result.errors[0]?.key).toBe('victorian-literature');
    expect(result.errors[0]?.message).toContain('Child category type mismatch');
  });
});

/**
 * 🔴 Регрессия, внесённая проверками обоих краёв ребра, и её починка.
 *
 * Пока край «вниз» сверялся только с базой, файл, переводящий поддерево
 * в другой тип, не проходил ни в каком порядке: родитель отвергался по
 * ребёнку прежнего типа, а ребёнок — по родителю, чья запись только что
 * откатилась. До правки `LEGACY-303` тот же файл давал `updated: 2`.
 *
 * Решение арбитра от 29.08.2026: край «вниз» сверяется с конечным состоянием
 * партии — ребёнок, объявленный в этом же файле с тем же новым типом,
 * разнотипным ребром не станет.
 *
 * ⚠️ Проверять надо оба термина партии, а не только родителя: спека
 * на одном из них зеленеет и на дефекте.
 */
/**
 * 🔴 `LEGACY-315`. Исключение по составу партии верно ровно настолько,
 * насколько партия атомарна, а она не атомарна: транзакция на термин.
 * Родитель коммитит смену типа, ребёнок следом падает по своей причине —
 * и в базе остаётся разнотипное ребро, которое ни один путь записи больше
 * не заведёт, но и не починит.
 *
 * ⚠️ Отчёт до правки был честен про упавшего ребёнка и молчал про дерево:
 * оператор видел «одна ошибка из двух» и не знал, что первая половина оставила
 * дерево в запрещённом состоянии. Проверять надо именно вторую строку отчёта.
 */
describe('ImportService — частично прошедшая партия называет испорченное ребро (LEGACY-315)', () => {
  const subtreeFile = (): ImportCategoryDto[] =>
    [
      {
        key: 'parent-key',
        type: CategoryType.collection,
        translations: { [Language.en]: { name: 'Parent', slug: 'parent' } },
      },
      {
        key: 'child-key',
        type: CategoryType.collection,
        parentKey: 'parent-key',
        translations: { [Language.en]: { name: 'Child', slug: 'child' } },
      },
    ] as ImportCategoryDto[];

  const rowsInDb: Record<string, unknown> = {
    'parent-key': {
      id: 'cat-parent',
      key: 'parent-key',
      type: CategoryType.genre,
      parentId: null,
      indexable: true,
      isVisible: true,
      sortOrder: 0,
      translations: [],
    },
    'child-key': {
      id: 'cat-child',
      key: 'child-key',
      type: CategoryType.genre,
      parentId: 'cat-parent',
      indexable: true,
      isVisible: true,
      sortOrder: 0,
      translations: [],
    },
  };

  /** Партия из двух терминов, где транзакция ребёнка падает на переводе. */
  const runBatchWithFailingChild = async (
    log: WriteLog,
    override?: (rootClient: ReturnType<typeof makeService>['root']) => void,
  ) => {
    const { service, root, tx } = makeService(log);

    root.category.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('root.category.findUnique');
      return Promise.resolve(rowsInDb[args?.where?.key ?? ''] ?? null);
    });

    let parentType: CategoryType = CategoryType.genre;
    tx.category.update.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('tx.category.update');
      if (args?.where?.key === 'parent-key') parentType = CategoryType.collection;
      return Promise.resolve({ id: 'cat-1' });
    });
    tx.category.findUnique.mockImplementation((args: { where?: { key?: string; id?: string } }) => {
      log.push('tx.category.findUnique');
      const where = args?.where ?? {};
      if (where.key === 'parent-key')
        return Promise.resolve({ ...(rowsInDb['parent-key'] as object), type: parentType });
      if (where.key === 'child-key') return Promise.resolve(rowsInDb['child-key']);
      if (where.id === 'cat-parent') return Promise.resolve({ parentId: null });
      return Promise.resolve(null);
    });
    // Край «вниз» у родителя пропускает ребёнка: файл переводит его в тот же тип.
    tx.category.findFirst.mockImplementation(
      (args: { where?: { parentId?: string; key?: { notIn?: string[] } } }) => {
        log.push('tx.category.findFirst');
        const where = args?.where ?? {};
        if (where.parentId !== 'cat-parent') return Promise.resolve(null);
        const excluded = where.key?.notIn ?? [];
        if (excluded.includes('child-key')) return Promise.resolve(null);
        return Promise.resolve({ id: 'cat-child', key: 'child-key', type: CategoryType.genre });
      },
    );
    // Ребёнок падает после того, как родитель уже закоммитился.
    tx.categoryTranslation.update.mockImplementation(() => {
      log.push('tx.categoryTranslation.update');
      return Promise.reject(new Error('slug conflict'));
    });
    tx.categoryTranslation.create.mockImplementation((args: { data?: { categoryId?: string } }) => {
      log.push('tx.categoryTranslation.create');
      if (args?.data?.categoryId === 'cat-child') {
        return Promise.reject(new Error('slug conflict'));
      }
      return Promise.resolve({});
    });
    // Второй проход спрашивает базу: ребро осталось разнотипным.
    //
    // ⚠️ Мок обязан честно исполнять условие отбора. Проход ищет детей
    // с типом, **не равным** ожидаемому: если отдавать строку на любой аргумент,
    // спека зеленеет и на возвращённом фильтре в память, из-за которого потолок
    // выборки съедали бы согласованные дети.
    root.category.findMany.mockImplementation(
      (args: {
        where?: { OR?: Array<{ parentId?: { in?: string[] }; type?: { not?: CategoryType } }> };
      }) => {
        log.push('root.category.findMany');
        const groups = args?.where?.OR ?? [];
        const matching = groups.some(
          (g) =>
            (g.parentId?.in ?? []).includes('cat-parent') && g.type?.not !== CategoryType.genre,
        );
        if (!matching) return Promise.resolve([]);
        return Promise.resolve([
          {
            key: 'child-key',
            type: CategoryType.genre,
            // Тип родителя приходит из базы, а не из файла.
            parent: { key: 'parent-key', type: CategoryType.collection },
          },
        ]);
      },
    );

    override?.(root);

    return { result: await service.importCategories(subtreeFile()), root, tx };
  };

  it('отчёт называет и упавшего ребёнка, и родителя, оставшегося разнотипным', async () => {
    const log: WriteLog = [];

    const { result } = await runBatchWithFailingChild(log);

    expect(result.errors.map((e) => e.key)).toEqual(['child-key', 'parent-key']);
    expect(result.errors[1].message).toContain('Tree left inconsistent');
    expect(result.errors[1].message).toContain('"child-key"');
  });

  it('проход спрашивает базу по идентификатору родителя и ничего не пишет', async () => {
    const log: WriteLog = [];

    const { root } = await runBatchWithFailingChild(log);

    // Запрос идёт по идентификатору из базы, а не по ключам файла: ребёнок,
    // не назвавший `parentKey`, иначе выпал бы из проверки.
    expect(root.category.findMany).toHaveBeenCalledTimes(1);
    expect(root.category.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [{ parentId: { in: ['cat-parent'] }, type: { not: CategoryType.collection } }],
        },
        orderBy: { key: 'asc' },
        take: expect.any(Number),
      }),
    );
    // Проход только читает: ни одной записи через `root.` он не добавляет.
    expect(writesOf(log).filter((call) => call.startsWith('root.'))).toEqual([]);
  });

  it('родитель, перетипизированный обратно после партии, ложной строки не даёт', async () => {
    const log: WriteLog = [];
    const { result, root } = await runBatchWithFailingChild(log, (rootClient) => {
      // Между записью и проходом кто-то вернул родителю прежний тип. Ребро
      // больше не разнотипное, и говорить про него нечего — хотя файл
      // по-прежнему утверждает, что родитель стал коллекцией.
      rootClient.category.findMany.mockImplementation(() => {
        log.push('root.category.findMany');
        return Promise.resolve([
          {
            key: 'child-key',
            type: CategoryType.genre,
            parent: { key: 'parent-key', type: CategoryType.genre },
          },
        ]);
      });
    });

    expect(root.category.findMany).toHaveBeenCalledTimes(1);
    expect(result.errors.map((e) => e.key)).toEqual(['child-key']);
  });

  it('упёршись в потолок выборки, проход говорит об этом, а не молчит', async () => {
    const log: WriteLog = [];
    // 🔴 `L-015`. Молчание проверки, которая проверила не всё, читается как
    // «всё в порядке». Потолок берётся из самого вызова, чтобы спека не зависела
    // от значения константы.
    const { result } = await runBatchWithFailingChild(log, (rootClient) => {
      rootClient.category.findMany.mockImplementation((args: { take?: number }) => {
        log.push('root.category.findMany');
        const take = args?.take ?? 0;
        return Promise.resolve(
          Array.from({ length: take }, (_, i) => ({
            key: `child-${i}`,
            type: CategoryType.genre,
            parent: { key: 'parent-key', type: CategoryType.collection },
          })),
        );
      });
    });

    const truncated = result.errors.filter((e) => e.key === '(consistency-scan)');
    expect(truncated).toHaveLength(1);
    expect(truncated[0].message).toContain('there may be more');
  });

  it('отказ самого прохода не роняет ручку, но и не выдаёт себя за чистый отчёт', async () => {
    const log: WriteLog = [];
    const { result } = await runBatchWithFailingChild(log, (rootClient) => {
      rootClient.category.findMany.mockImplementation(() => {
        log.push('root.category.findMany');
        return Promise.reject(new Error('pool timeout'));
      });
    });

    // Отчёт про упавшего ребёнка обязан дойти до оператора: без него он не знает,
    // что остальные термины уже записаны, и погонит файл заново.
    expect(result.updated).toBe(1);
    expect(result.errors.map((e) => e.key)).toEqual(['child-key', '(consistency-scan)']);
    // 🔴 `L-015`. Молчание здесь совпало бы с отчётом по целому дереву байт в байт.
    expect(result.errors[1].message).toContain('could not run');
  });

  it('партия без ошибок второго прохода не делает вовсе', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);

    root.category.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('root.category.findUnique');
      return Promise.resolve(rowsInDb[args?.where?.key ?? ''] ?? null);
    });
    let parentType: CategoryType = CategoryType.genre;
    tx.category.update.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('tx.category.update');
      if (args?.where?.key === 'parent-key') parentType = CategoryType.collection;
      return Promise.resolve({ id: 'cat-1' });
    });
    tx.category.findUnique.mockImplementation((args: { where?: { key?: string; id?: string } }) => {
      log.push('tx.category.findUnique');
      const where = args?.where ?? {};
      if (where.key === 'parent-key')
        return Promise.resolve({ ...(rowsInDb['parent-key'] as object), type: parentType });
      if (where.key === 'child-key') return Promise.resolve(rowsInDb['child-key']);
      if (where.id === 'cat-parent') return Promise.resolve({ parentId: null });
      return Promise.resolve(null);
    });
    tx.category.findFirst.mockResolvedValue(null);

    const result = await service.importCategories(subtreeFile());

    expect(result).toEqual({ imported: 0, updated: 2, errors: [] });
    expect(root.category.findMany).not.toHaveBeenCalled();
  });
});

describe('ImportService — перетипизация поддерева одним файлом', () => {
  const subtreeFile = (): ImportCategoryDto[] =>
    [
      {
        key: 'parent-key',
        type: CategoryType.collection,
        translations: { [Language.en]: { name: 'Parent', slug: 'parent' } },
      },
      {
        key: 'child-key',
        type: CategoryType.collection,
        parentKey: 'parent-key',
        translations: { [Language.en]: { name: 'Child', slug: 'child' } },
      },
    ] as ImportCategoryDto[];

  it('родитель и ребёнок меняют тип вместе, а не отвергают друг друга', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);

    // В базе оба ещё жанры, ребёнок висит под родителем.
    const rowsInDb: Record<string, unknown> = {
      'parent-key': {
        id: 'cat-parent',
        key: 'parent-key',
        type: CategoryType.genre,
        parentId: null,
        indexable: true,
        isVisible: true,
        sortOrder: 0,
        translations: [],
      },
      'child-key': {
        id: 'cat-child',
        key: 'child-key',
        type: CategoryType.genre,
        parentId: 'cat-parent',
        indexable: true,
        isVisible: true,
        sortOrder: 0,
        translations: [],
      },
    };

    root.category.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('root.category.findUnique');
      return Promise.resolve(rowsInDb[args?.where?.key ?? ''] ?? null);
    });

    // Родитель обрабатывается первым и к моменту записи ребёнка уже коллекция.
    let parentType: CategoryType = CategoryType.genre;
    tx.category.update.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('tx.category.update');
      if (args?.where?.key === 'parent-key') parentType = CategoryType.collection;
      return Promise.resolve({ id: 'cat-1' });
    });
    tx.category.findUnique.mockImplementation((args: { where?: { key?: string; id?: string } }) => {
      log.push('tx.category.findUnique');
      const where = args?.where ?? {};
      if (where.key === 'parent-key')
        return Promise.resolve({ ...(rowsInDb['parent-key'] as object), type: parentType });
      if (where.key === 'child-key') return Promise.resolve(rowsInDb['child-key']);
      if (where.id === 'cat-parent') return Promise.resolve({ parentId: null });
      return Promise.resolve(null);
    });
    // ⚠️ Ребёнок прежнего типа в базе ЕСТЬ. Мок обязан честно исполнять
    // условие `key: { notIn }` — иначе спека зеленеет и на снятом исключении,
    // то есть не стережёт ничего.
    tx.category.findFirst.mockImplementation(
      (args: { where?: { parentId?: string; key?: { notIn?: string[] } } }) => {
        log.push('tx.category.findFirst');
        const where = args?.where ?? {};
        // Дети есть только у родителя; у самого ребёнка их нет.
        if (where.parentId !== 'cat-parent') return Promise.resolve(null);
        const excluded = where.key?.notIn ?? [];
        if (excluded.includes('child-key')) return Promise.resolve(null);
        return Promise.resolve({
          id: 'cat-child',
          key: 'child-key',
          type: CategoryType.genre,
        });
      },
    );

    const result = await service.importCategories(subtreeFile());

    expect(result.errors).toEqual([]);
    expect(result.updated).toBe(2);
  });

  /**
   * Обратная сторона: ребёнок, которого в файле НЕТ, по-прежнему отвергает
   * смену типа родителя. Иначе исключение по партии превратилось бы
   * в снятие проверки.
   */
  it('ребёнок вне файла по-прежнему отвергает смену типа родителя', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);

    const parentRow = {
      id: 'cat-parent',
      key: 'parent-key',
      type: CategoryType.genre,
      parentId: null,
      indexable: true,
      isVisible: true,
      sortOrder: 0,
      translations: [],
    };
    root.category.findUnique.mockResolvedValue(parentRow);
    tx.category.findUnique.mockImplementation((args: { where?: { key?: string } }) =>
      Promise.resolve(args?.where?.key === 'parent-key' ? parentRow : null),
    );
    tx.category.findFirst.mockResolvedValue({
      id: 'cat-stranger',
      key: 'stranger-key',
      type: CategoryType.genre,
    });

    const result = await service.importCategories([subtreeFile()[0]]);

    expect(result.updated).toBe(0);
    expect(result.errors[0]?.message).toContain('Child category type mismatch');
    // Термин в тексте назван ключом, а не UUID: в файле оператора UUID нет.
    expect(result.errors[0]?.message).toContain('stranger-key');
  });
});
