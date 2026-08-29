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
    tx.category.findUnique.mockImplementation((args: { where?: { key?: string; id?: string } }) => {
      log.push('tx.category.findUnique');
      const where = args?.where ?? {};
      if (where.key === 'classic-literature')
        return Promise.resolve({ id: 'parent-1', type: CategoryType.genre });
      if (where.key === 'victorian-literature')
        return Promise.resolve({ id: 'cat-1', type: CategoryType.genre });
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
      if (where.key === 'victorian-literature')
        return Promise.resolve({ id: 'cat-1', type: CategoryType.genre });
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
    const { service, root, $transaction } = makeService(log);

    root.tag.findUnique.mockImplementation(() => {
      log.push('root.tag.findUnique');
      return Promise.resolve(existingTag);
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
    const { service, root, tx, $transaction } = makeService(log);

    root.tag.findUnique.mockImplementation(() => {
      log.push('root.tag.findUnique');
      return Promise.resolve(existingTag);
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
        return Promise.resolve({ id: 'cat-classic', type: CategoryType.genre });
      if (where.key === 'victorian-literature')
        return Promise.resolve({ id: 'cat-victorian', type: parentType });
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
