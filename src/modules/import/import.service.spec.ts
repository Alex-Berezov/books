import { CategoryType, Language } from '@prisma/client';
import { CategoryTreeService } from '../category/category-tree.service';
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
    $queryRaw: jest.fn().mockImplementation(() => {
      log.push(`${label}:lockTree`);
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
  );

  return { service, prisma, root, tx, $transaction };
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

  it('дефолты берутся из строки транзакции, а не из чтения на пуле (LEGACY-304)', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);

    // На пуле лежит устаревший `sortOrder`: по нему запись затёрла бы чужую правку.
    root.category.findUnique.mockImplementation(() => {
      log.push('root.category.findUnique');
      return Promise.resolve({ ...existingInTx, sortOrder: 0 });
    });
    tx.category.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('tx.category.findUnique');
      return Promise.resolve(args?.where?.key === 'victorian-literature' ? existingInTx : null);
    });

    await service.importCategories([categoryDto()]);

    expect(tx.category.update).toHaveBeenCalledTimes(1);
    expect(tx.category.update).toHaveBeenCalledWith({
      where: { key: 'victorian-literature' },
      data: expect.objectContaining({ sortOrder: 42 }),
    });
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

  it('дефолты берутся из строки транзакции, а не из чтения на пуле', async () => {
    const log: WriteLog = [];
    const { service, root, tx } = makeService(log);

    // На пуле лежит устаревший `sortOrder`: по нему запись затёрла бы чужую правку.
    root.tag.findUnique.mockImplementation(() => {
      log.push('root.tag.findUnique');
      return Promise.resolve({ ...existingInTx, sortOrder: 0 });
    });
    tx.tag.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('tx.tag.findUnique');
      return Promise.resolve(args?.where?.key === 'aestheticism' ? existingInTx : null);
    });

    await service.importTags([tagDto()]);

    expect(tx.tag.update).toHaveBeenCalledTimes(1);
    expect(tx.tag.update).toHaveBeenCalledWith({
      where: { key: 'aestheticism' },
      data: expect.objectContaining({ sortOrder: 42 }),
    });
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
