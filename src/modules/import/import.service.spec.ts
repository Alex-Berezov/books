import { CategoryType, Language } from '@prisma/client';
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
  log.filter((call) => call.endsWith('.create') || call.endsWith('.update'));

const makeService = (log: WriteLog) => {
  const tx = makeClient('tx', log);
  const root = makeClient('root', log);
  const $transaction = jest
    .fn()
    .mockImplementation((run: (client: FakeClient) => Promise<unknown>) => run(tx));
  const prisma = { ...root, $transaction };
  const slugRedirects = {
    record: jest.fn().mockResolvedValue(undefined),
    recordBaseSlugChange: jest.fn().mockResolvedValue(undefined),
  };

  const service = new ImportService(
    prisma as unknown as PrismaService,
    slugRedirects as unknown as SlugRedirectService,
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

describe('ImportService — создание термина и переводов одной транзакцией (LEGACY-131)', () => {
  it('пишет категорию, её родителя и переводы только клиентом транзакции', async () => {
    const log: WriteLog = [];
    const { service, root, tx, $transaction } = makeService(log);

    // Родитель есть в базе — иначе импорт отбраковал бы запись до записи вовсе.
    root.category.findUnique.mockImplementation((args: { where?: { key?: string } }) => {
      log.push('root.category.findUnique');
      return Promise.resolve(args?.where?.key === 'classic-literature' ? { id: 'parent-1' } : null);
    });
    tx.category.findUnique.mockImplementation(() => {
      log.push('tx.category.findUnique');
      return Promise.resolve({ id: 'parent-1' });
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
      select: { id: true },
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
  /** Термин уже в базе: один перевод есть, второй придёт с импортом. */
  const existingCategory = {
    id: 'cat-1',
    indexable: true,
    isVisible: true,
    sortOrder: 0,
    translations: [{ language: Language.en, slug: 'victorian-literature' }],
  };

  const existingTag = {
    id: 'tag-1',
    slug: 'aestheticism',
    indexable: true,
    isVisible: true,
    sortOrder: 0,
    translations: [{ language: Language.en, slug: 'aestheticism' }],
  };

  it('пишет базовую строку и оба перевода категории одним клиентом транзакции', async () => {
    const log: WriteLog = [];
    const { service, root, $transaction } = makeService(log);

    root.category.findUnique.mockImplementation(() => {
      log.push('root.category.findUnique');
      return Promise.resolve(existingCategory);
    });

    const result = await service.importCategories([categoryDto()]);

    expect(result).toEqual({ imported: 0, updated: 1, errors: [] });
    // Одна транзакция на весь термин, а не по одной на каждый существующий перевод.
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(writesOf(log)).toEqual([
      'tx.category.update',
      'tx.categoryTranslation.update',
      'tx.categoryTranslation.create',
    ]);
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

    // Счётчик и база обязаны говорить одно и то же: инкремент `updated` стоит
    // после коммита, а не до него.
    expect(result.updated).toBe(0);
    expect(result.errors).toEqual([{ key: 'victorian-literature', message: 'slug conflict' }]);
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(writesOf(log).filter((call) => call.startsWith('root.'))).toEqual([]);
  });

  it('пишет базовую строку и оба перевода тега одним клиентом транзакции', async () => {
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
      'tx.tag.update',
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
    tx.category.findUnique.mockImplementation(() => {
      log.push('tx.category.findUnique');
      return Promise.resolve({ id: 'cat-1' });
    });

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
