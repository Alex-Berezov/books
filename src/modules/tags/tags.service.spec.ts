import { TagsService } from './tags.service';
import { TAG_TX_OPTIONS, TagLockService } from './tag-lock.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TaxonomyIndexabilityService } from '../seo/indexability/taxonomy-indexability.service';
import { AdminAuditService } from '../../shared/admin-audit/admin-audit.service';
import { SlugRedirectService } from '../slug-redirect/slug-redirect.service';
import { Language } from '@prisma/client';

interface PrismaStub {
  $transaction: jest.Mock;
  $queryRaw: jest.Mock;
  tag: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    count: jest.Mock;
    findMany: jest.Mock;
    delete: jest.Mock;
  };
  tagTranslation: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    delete: jest.Mock;
    deleteMany: jest.Mock;
  };
  bookVersion: { findMany: jest.Mock; findUnique: jest.Mock; count: jest.Mock };
  bookTag: { findFirst: jest.Mock; create: jest.Mock; delete: jest.Mock; deleteMany: jest.Mock };
  bookRating: { groupBy: jest.Mock };
}

const createPrismaStub = (): PrismaStub => ({
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
  tag: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    findMany: jest.fn(),
    delete: jest.fn(),
  },
  tagTranslation: {
    findUnique: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  },
  bookVersion: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
  bookTag: { findFirst: jest.fn(), create: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
  bookRating: { groupBy: jest.fn() },
});

describe('TagsService', () => {
  let service: TagsService;
  let prisma: PrismaStub;
  let indexability: { recomputeForTerms: jest.Mock };
  let adminAudit: { record: jest.Mock };
  let slugRedirects: {
    record: jest.Mock;
    resolve: jest.Mock;
    recordBaseSlugChange: jest.Mock;
    cleanupDeadRedirects: jest.Mock;
  };

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
      cleanupDeadRedirects: jest.fn().mockResolvedValue(undefined),
    };
    adminAudit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new TagsService(
      prisma as unknown as PrismaService,
      slugRedirects as unknown as SlugRedirectService,
      new TagLockService(prisma as unknown as PrismaService),
      adminAudit as unknown as AdminAuditService,
      indexability as unknown as TaxonomyIndexabilityService,
    );
  });

  describe('list projects per-language indexability', () => {
    const translation = (
      language: Language,
      slug: string,
      bookCount: number,
      autoIndexable: boolean,
    ) => ({
      language,
      name: slug,
      slug,
      description: null,
      relatedTagSlugs: null,
      relatedGenreSlugs: null,
      relatedCategorySlugs: null,
      relatedCollectionSlugs: null,
      bookCount,
      autoIndexable,
    });

    beforeEach(() => {
      prisma.$transaction = jest
        .fn()
        .mockImplementation((ops: Array<Promise<unknown>>) => Promise.all(ops));
      prisma.tag.count.mockResolvedValue(2);
      prisma.tag.findMany.mockResolvedValue([
        {
          id: 't1',
          name: 'Adventure',
          slug: 'adventure',
          key: 'adventure',
          indexable: true,
          isVisible: true,
          sortOrder: 0,
          translations: [
            translation(Language.en, 'adventure', 7, true),
            translation(Language.es, 'aventura', 2, false),
          ],
        },
        {
          id: 't2',
          name: 'Poetry',
          slug: 'poetry',
          key: 'poetry',
          indexable: true,
          isVisible: true,
          sortOrder: 1,
          translations: [translation(Language.en, 'poetry', 9, true)],
        },
      ]);
      prisma.$queryRaw.mockResolvedValue([{ tagId: 't1', booksCount: 2 }]);
    });

    it('takes autoIndexable from the requested language, not from another one', async () => {
      const res = await service.list(1, 20, undefined, Language.es);
      const tag = res.data.find((t) => t.id === 't1');

      expect(tag?.autoIndexable).toBe(false);
      expect(tag?.langBookCount).toBe(2);
    });

    it('leaves both fields undefined when lang is not passed', async () => {
      const res = await service.list(1, 20);

      expect(res.data[0].autoIndexable).toBeUndefined();
      expect(res.data[0].langBookCount).toBeUndefined();
    });

    it('leaves both fields undefined for a tag without a translation into lang', async () => {
      const res = await service.list(1, 20, undefined, Language.es);
      const tag = res.data.find((t) => t.id === 't2');

      expect(tag?.autoIndexable).toBeUndefined();
      expect(tag?.langBookCount).toBeUndefined();
    });

    it('keeps booksCount live and exposes per-translation indexability', async () => {
      const res = await service.list(1, 20, undefined, Language.es);
      const tag = res.data.find((t) => t.id === 't1');

      expect(tag?.booksCount).toBe(2);
      // The sitemap picks a translation by language and needs the same signal there.
      expect(tag?.translations).toEqual([
        expect.objectContaining({ language: Language.en, bookCount: 7, autoIndexable: true }),
        expect.objectContaining({ language: Language.es, bookCount: 2, autoIndexable: false }),
      ]);
    });

    // LEGACY-117. Проверяется именно **отсутствие вызова** `$queryRaw`: код, который
    // зовёт raw и глотает исключение, тоже вернёт пустой список.
    it('returns an empty page without touching $queryRaw when the page is out of range', async () => {
      prisma.tag.count.mockResolvedValue(42);
      prisma.tag.findMany.mockResolvedValue([]);
      prisma.$queryRaw.mockRejectedValue(new Error('$queryRaw must not be reached'));

      const res = await service.list(99, 20, undefined, Language.es);

      expect(res.data).toEqual([]);
      expect(res.meta).toEqual({ page: 99, limit: 20, total: 42, totalPages: 3 });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  /**
   * `LEGACY-199`, второй рубеж. `PublicTagBooksQueryDto` стережёт только вход через
   * контроллер, а метод публичный: второй его зов - из кода, из админского пути,
   * из копии соседнего маршрута - ушёл бы в `skip`/`take` с чем угодно. Спека зовёт
   * сервис **напрямую**, минуя пайп, - именно так, как это сделал бы такой зов.
   */
  describe('versionsByTagLangSlug: потолок и номер страницы вторым рубежом', () => {
    beforeEach(() => {
      prisma.tagTranslation.findUnique.mockResolvedValue({
        tag: { id: 't1', name: 'Tag', slug: 'tag', isVisible: true },
        seo: null,
        description: null,
      });
      prisma.bookVersion.findMany.mockResolvedValue([]);
      // Достаточно большой, чтобы страница не попала под короткий выход
      // `skip >= total` (`LEGACY-301`) — эти кейсы про потолок и клампинг
      // page/limit, а не про сам короткий выход, у него свои тесты ниже.
      prisma.bookVersion.count.mockResolvedValue(1000);
      prisma.bookRating.groupBy.mockResolvedValue([]);
    });

    const pageArgs = (): { skip: number; take: number } =>
      prisma.bookVersion.findMany.mock.calls[0][0] as { skip: number; take: number };

    it('limit выше потолка обрезается до потолка', async () => {
      const res = await service.versionsByTagLangSlug(Language.en, 'tag', 1, 1000);

      expect(pageArgs().take).toBe(48);
      // `meta` собирается из применённого значения: иначе потребитель поделит `total`
      // на запрошенный `limit` и насчитает страницы, которых нет.
      expect(res.meta.limit).toBe(48);
    });

    it('мусорные значения не уезжают в skip и take', async () => {
      const res = await service.versionsByTagLangSlug(Language.en, 'tag', Number.NaN, Number.NaN);

      expect(pageArgs()).toEqual(expect.objectContaining({ skip: 0, take: 1 }));
      expect(res.meta.page).toBe(1);
      expect(Number.isNaN(res.meta.totalPages)).toBe(false);
    });

    it('отрицательный номер страницы не даёт отрицательный skip', async () => {
      await service.versionsByTagLangSlug(Language.en, 'tag', -5, 10);

      expect(pageArgs().skip).toBe(0);
    });
  });

  /**
   * `LEGACY-301`. `page`, ведущий за пределы выдачи тега, заставлял базу
   * отсортировать всю выборку и отбросить её целиком: `LIMIT/OFFSET` режет
   * страницу **после** сортировки, поэтому стоимость с ростом `page` не падала.
   * Образец короткого выхода — `BookService.findCards` (`LEGACY-255`).
   */
  describe('versionsByTagLangSlug: короткий выход за пределами выдачи (LEGACY-301)', () => {
    beforeEach(() => {
      prisma.tagTranslation.findUnique.mockResolvedValue({
        tag: { id: 't1', name: 'Tag', slug: 'tag', isVisible: true },
        seo: null,
        description: null,
      });
      prisma.bookRating.groupBy.mockResolvedValue([]);
    });

    it('страница за total не ходит в базу за строками — только считает total', async () => {
      prisma.bookVersion.count.mockResolvedValue(5);
      // Единственный оставшийся зов `findMany` — независимый от страницы запрос
      // `availableLanguages`; если бы страничный запрос всё же ушёл, он вернул
      // бы этот же массив и тест остался бы зелёным по случайности, поэтому
      // проверяется именно число вызовов, а не форма ответа.
      prisma.bookVersion.findMany.mockResolvedValue([]);

      const res = await service.versionsByTagLangSlug(Language.en, 'tag', 4, 2);

      expect(prisma.bookVersion.count).toHaveBeenCalledTimes(1);
      expect(prisma.bookVersion.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.bookVersion.findMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ skip: expect.any(Number), take: expect.any(Number) }),
      );
      expect(res.data).toEqual([]);
      expect(res.meta).toEqual({ page: 4, limit: 2, total: 5, totalPages: 3 });
    });

    it('страница внутри выдачи по-прежнему идёт в базу за строками', async () => {
      prisma.bookVersion.count.mockResolvedValue(5);
      prisma.bookVersion.findMany.mockResolvedValue([]);

      await service.versionsByTagLangSlug(Language.en, 'tag', 1, 2);

      expect(prisma.bookVersion.findMany).toHaveBeenCalledTimes(2);
      expect(prisma.bookVersion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 2 }),
      );
    });
  });

  it('attach is idempotent and checks existence', async () => {
    prisma.bookVersion.findUnique = jest.fn().mockResolvedValue({ id: 'v1', bookId: 'b1' });
    prisma.bookVersion.findMany = jest.fn().mockResolvedValue([{ id: 'v1' }]);
    prisma.tag.findUnique.mockResolvedValue({ id: 't1' });
    prisma.bookTag.findFirst.mockResolvedValue({ id: 'link1' });
    const res = await service.attach('v1', 't1');
    expect(res).toEqual({ id: 'link1' });
    expect(prisma.bookTag.create).not.toHaveBeenCalled();
  });

  it('detach is idempotent when link absent', async () => {
    prisma.bookVersion.findUnique = jest.fn().mockResolvedValue({ id: 'v1', bookId: 'b1' });
    prisma.bookVersion.findMany = jest.fn().mockResolvedValue([{ id: 'v1' }]);
    const res = await service.detach('v1', 't1');
    expect(res).toEqual({ success: true });
  });

  it('detaching a tag recomputes that term, not the version', async () => {
    prisma.bookVersion.findUnique = jest.fn().mockResolvedValue({ id: 'v1', bookId: 'b1' });
    prisma.bookVersion.findMany = jest.fn().mockResolvedValue([{ id: 'v1' }]);

    await service.detach('v1', 't1');

    expect(indexability.recomputeForTerms).toHaveBeenCalledWith([], ['t1']);
  });

  it('attaching a tag recomputes that term', async () => {
    prisma.bookVersion.findUnique = jest.fn().mockResolvedValue({ id: 'v1', bookId: 'b1' });
    prisma.bookVersion.findMany = jest.fn().mockResolvedValue([{ id: 'v1' }]);
    prisma.tag.findUnique.mockResolvedValue({ id: 't1' });
    prisma.bookTag.findFirst.mockResolvedValue(null);

    await service.attach('v1', 't1');

    expect(indexability.recomputeForTerms).toHaveBeenCalledWith([], ['t1']);
  });

  it('creates a translation that is not indexable until it earns it', async () => {
    prisma.tag.findUnique.mockResolvedValue({ id: 't1' });
    prisma.tagTranslation.create = jest.fn().mockResolvedValue({ id: 'tr1' });

    await service.createTranslation('t1', {
      language: Language.en,
      name: 'Adventure',
      slug: 'adventure',
    });

    expect(prisma.tagTranslation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ bookCount: 0, autoIndexable: false }),
      }),
    );
  });

  /**
   * `LEGACY-085`, утверждающий тест — вторая половина политики, выбранной владельцем
   * 15.09.2026 (вариант D): редирект на родителя там, где родитель есть, и 404 там,
   * где его нет. У `Tag` родителя нет **по построению схемы** (`prisma/schema.prisma`,
   * `model Tag` — поля `parentId` нет вовсе), поэтому 404 здесь не «ещё не починено»,
   * а исполненное решение.
   *
   * Близнец в `category.service.spec.ts` проверяет противоположную половину — там
   * родитель есть и редирект пишется. Красное здесь означает, что кто-то завёл
   * редирект тега в обход решения, а не что «сломалось».
   */
  it('LEGACY-085: у тега родителя нет — удаление перевода оставляет 404', async () => {
    prisma.tagTranslation.findUnique.mockResolvedValue({
      tagId: 't1',
      language: Language.ru,
      slug: 'prikliucheniya',
      seoId: null,
    });
    prisma.tagTranslation.delete.mockResolvedValue({});

    await service.deleteTranslation('t1', Language.ru, 'admin-actor-1');

    expect(prisma.tagTranslation.delete).toHaveBeenCalledTimes(1);
    expect(slugRedirects.record).not.toHaveBeenCalled();
  });

  describe('remove (LEGACY-395)', () => {
    beforeEach(() => {
      prisma.tag.findUnique.mockResolvedValue({ id: 't1', slug: 'classics' });
      prisma.tag.delete.mockResolvedValue({ id: 't1', slug: 'classics' });
    });

    it('cleans up both the dying translations and the dead-language base slug', async () => {
      // 1-й вызов — умирающие переводы, читаются до удаления; 2-й —
      // `deadLanguagesForTagSlug`, ищет живые переводы с базовым слагом
      // ('classics') у чужих тегов: таких нет.
      prisma.tagTranslation.findMany
        .mockResolvedValueOnce([
          { language: Language.en, slug: 'classic-books' },
          { language: Language.ru, slug: 'klassika' },
        ])
        .mockResolvedValueOnce([]);
      // Ни умирающие слаги переводов, ни бывший базовый слаг не заняты
      // чужим живым базовым слагом.
      prisma.tag.findFirst.mockResolvedValue(null);

      const res = await service.remove('t1', 'admin-actor-1');

      expect(res.id).toBe('t1');
      expect(prisma.bookTag.deleteMany).toHaveBeenCalledWith({ where: { tagId: 't1' } });
      expect(prisma.tagTranslation.deleteMany).toHaveBeenCalledWith({ where: { tagId: 't1' } });
      expect(prisma.tag.delete).toHaveBeenCalledWith({ where: { id: 't1' } });

      expect(slugRedirects.cleanupDeadRedirects).toHaveBeenCalledWith(
        'tag',
        [Language.en],
        'classic-books',
        prisma,
      );
      expect(slugRedirects.cleanupDeadRedirects).toHaveBeenCalledWith(
        'tag',
        [Language.ru],
        'klassika',
        prisma,
      );
      const baseCall = slugRedirects.cleanupDeadRedirects.mock.calls.find(
        (call) => call[2] === 'classics',
      );
      expect(baseCall?.[0]).toBe('tag');
      expect(baseCall?.[1]).toEqual(Object.values(Language));
    });

    it("does not clean up a dying translation slug that is still someone else's live base slug", async () => {
      prisma.tagTranslation.findMany
        .mockResolvedValueOnce([{ language: Language.en, slug: 'fiction' }])
        .mockResolvedValueOnce([]);
      // 'fiction' — базовый слаг другого живого тега: адрес пережил удаление.
      // Базовый слаг удалённого тега ('classics') не занят никем.
      prisma.tag.findFirst.mockResolvedValueOnce({ id: 'other-tag' }).mockResolvedValueOnce(null);

      await service.remove('t1', 'admin-actor-1');

      expect(slugRedirects.cleanupDeadRedirects).not.toHaveBeenCalledWith(
        'tag',
        [Language.en],
        'fiction',
        prisma,
      );
    });

    it('throws NotFoundException and touches nothing when the tag does not exist', async () => {
      prisma.tag.findUnique.mockResolvedValue(null);

      await expect(service.remove('missing', 'admin-actor-1')).rejects.toThrow('Tag not found');
      expect(prisma.tag.delete).not.toHaveBeenCalled();
      expect(slugRedirects.cleanupDeadRedirects).not.toHaveBeenCalled();
    });

    it('runs inside the tag lock with explicit bounds', async () => {
      prisma.tag.findFirst.mockResolvedValue(null);

      await service.remove('t1', 'admin-actor-1');

      expect(prisma.$transaction.mock.calls).toEqual([[expect.any(Function), TAG_TX_OPTIONS]]);
    });

    // `LEGACY-395` (находка ревью): `versionsByTagLangSlug` считает базовый
    // слаг живым только у видимого тега (`isVisible: true`) — скрытый тег
    // адрес не оживляет. Без этого условия в запросе уборка ошибочно решила
    // бы, что слаг занят, и пропустила бы её на уже мёртвом публично адресе.
    it('asks liveness only about visible tags, matching the public resolver', async () => {
      prisma.tagTranslation.findMany
        .mockResolvedValueOnce([{ language: Language.en, slug: 'fiction' }])
        .mockResolvedValueOnce([]);
      prisma.tag.findFirst.mockResolvedValue(null);

      await service.remove('t1', 'admin-actor-1');

      for (const call of prisma.tag.findFirst.mock.calls) {
        expect((call[0] as { where: { isVisible?: boolean } }).where.isVisible).toBe(true);
      }
      expect(prisma.tagTranslation.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tag: { isVisible: true } }),
        }),
      );
    });
  });

  /**
   * 🔴 `LEGACY-015`, пачка `T20`. Тот же критерий и та же форма, что у категории
   * (`category.service.spec.ts`, блок «журнал административных действий»):
   * событие на сам термин со списком умерших переводов в `payload`, отдельных
   * событий на переводы нет (решение арбитра 20.09.2026).
   */
  describe('журнал административных действий (LEGACY-015, T20)', () => {
    beforeEach(() => {
      prisma.tag.findUnique.mockResolvedValue({ id: 't1', slug: 'classics' });
      prisma.tag.delete.mockResolvedValue({ id: 't1', slug: 'classics' });
      prisma.tag.findFirst.mockResolvedValue(null);
    });

    it('remove пишет TAG_DELETED со списком умерших переводов', async () => {
      const dying = [
        { language: Language.en, slug: 'classic-books' },
        { language: Language.ru, slug: 'klassika' },
      ];
      prisma.tagTranslation.findMany.mockResolvedValueOnce(dying).mockResolvedValueOnce([]);

      await service.remove('t1', 'admin-actor-1');

      expect(adminAudit.record).toHaveBeenCalledTimes(1);
      // ⚠️ Первый аргумент `record` здесь НЕ проверяется: `$transaction` этого
      // стенда (`:66-68`) отдаёт колбэку сам `prisma`, поэтому `tx === prisma`
      // и любая такая сверка истинна при любом аргументе. Настоящая посадка
      // на `LEGACY-036` — в блоке «писатели тега идут под замком» ниже, где
      // `tx` и `root` различимы (`L-016`).
      expect(adminAudit.record.mock.calls[0][1]).toEqual({
        action: 'TAG_DELETED',
        targetType: 'TAG',
        targetId: 't1',
        actorUserId: 'admin-actor-1',
        payload: { slug: 'classics', translations: dying },
      });
    });

    it('несуществующий тег журнала не касается', async () => {
      prisma.tag.findUnique.mockResolvedValue(null);

      await expect(service.remove('missing', 'admin-actor-1')).rejects.toThrow('Tag not found');
      expect(adminAudit.record).not.toHaveBeenCalled();
    });

    /**
     * ⚠️ `targetId` — идентификатор **тега**, хотя у строки перевода есть своё `id`:
     * язык стоит в `payload`, и вся история термина собирается одной выборкой
     * по `targetId` (решение арбитра 20.09.2026).
     */
    it('deleteTranslation пишет TAG_TRANSLATION_DELETED на сам тег', async () => {
      prisma.tagTranslation.findUnique.mockResolvedValue({
        id: 'translation-row-1',
        tagId: 't1',
        language: Language.ru,
        slug: 'klassika',
        seoId: null,
      });
      prisma.tagTranslation.delete.mockResolvedValue({});

      await service.deleteTranslation('t1', Language.ru, 'admin-actor-1');

      expect(adminAudit.record).toHaveBeenCalledTimes(1);
      expect(adminAudit.record.mock.calls[0][1]).toEqual({
        action: 'TAG_TRANSLATION_DELETED',
        targetType: 'TAG',
        targetId: 't1',
        actorUserId: 'admin-actor-1',
        payload: { language: Language.ru, slug: 'klassika' },
      });
    });

    /**
     * Инвариант «событие = изменение состояния» (`M5`, 11.09.2026): удалять было
     * нечего — записывать тоже.
     */
    it('отсутствующий перевод журнала не касается', async () => {
      prisma.tagTranslation.findUnique.mockResolvedValue(null);

      await service.deleteTranslation('t1', Language.ru, 'admin-actor-1');

      expect(adminAudit.record).not.toHaveBeenCalled();
    });
  });
});

/**
 * 🔴 `LEGACY-360`, `LEGACY-320`. Каким клиентом сделано каждое обращение:
 * `root` — клиент пула, `tx` — клиент транзакции, открытой `runInLockedTag`.
 * Журнал проверяет и порядок: замок — первым оператором.
 */
describe('TagsService — писатели тега идут под замком (LEGACY-360)', () => {
  type Handler = (...args: unknown[]) => unknown;
  type FakeClient = Record<string, unknown>;

  const makeClient = (label: 'root' | 'tx', log: string[], impl: Record<string, Handler>) => {
    const cache: FakeClient = {};
    return new Proxy(cache, {
      get(target, model: string) {
        if (model in target) return target[model];
        if (model === '$queryRaw') {
          target[model] = jest.fn((strings: TemplateStringsArray) => {
            // Метка ставится только по признаку замка, а не «всё остальное»:
            // запрос без `FOR UPDATE` не должен сходить за замок строки.
            const sql = strings.join('?');
            const lock = sql.includes('FOR UPDATE')
              ? 'forUpdate'
              : sql.includes('pg_advisory_xact_lock') && sql.includes('hashtext')
                ? 'advisory'
                : 'rawUnknown';
            log.push(`${label}.${lock}`);
            return Promise.resolve([]);
          });
        } else {
          const ops: Record<string, jest.Mock> = {};
          target[model] = new Proxy(ops, {
            get(opsTarget, op: string) {
              opsTarget[op] ??= jest.fn((...args: unknown[]) => {
                log.push(`${label}.${model}.${op}`);
                const fn = impl[`${model}.${op}`];
                return Promise.resolve().then(() => (fn ? fn(...args) : null));
              });
              return opsTarget[op];
            },
          });
        }
        return target[model];
      },
    });
  };

  const setup = (impl: Record<string, Handler> = {}) => {
    const log: string[] = [];
    const tx = makeClient('tx', log, impl);
    const root = makeClient('root', log, impl);
    const $transaction = jest.fn((cb: (client: FakeClient) => unknown) => cb(tx));
    const prismaClient = new Proxy(root, {
      get: (target, prop: string) => (prop === '$transaction' ? $transaction : target[prop]),
    });
    // `cleanupDeadRedirects` в стенде есть потому, что `remove` её зовёт
    // (`tags.service.ts:270`): без неё блок не может прогнать удаление тега вовсе.
    const redirects = {
      record: jest.fn(),
      recordBaseSlugChange: jest.fn(),
      cleanupDeadRedirects: jest.fn().mockResolvedValue(undefined),
    };
    const adminAudit = { record: jest.fn().mockResolvedValue(undefined) };
    const tagsService = new TagsService(
      prismaClient as unknown as PrismaService,
      redirects as unknown as SlugRedirectService,
      new TagLockService(prismaClient as unknown as PrismaService),
      adminAudit as unknown as AdminAuditService,
      { recomputeForTerms: jest.fn() } as unknown as TaxonomyIndexabilityService,
    );
    return { tagsService, log, tx, $transaction, redirects, adminAudit };
  };

  const rootCalls = (log: string[]) => log.filter((call) => call.startsWith('root.'));

  it('createTranslation: Seo и перевод пишутся одной транзакцией под замком строки', async () => {
    const { tagsService, log, $transaction } = setup({
      'tag.findUnique': () => ({ id: 't1' }),
      'seo.create': () => ({ id: 7 }),
      'tagTranslation.create': () => ({ id: 'tr1' }),
    });

    await tagsService.createTranslation('t1', {
      language: Language.en,
      name: 'N',
      slug: 'n',
      seo: { metaTitle: 'T' },
    });

    expect($transaction.mock.calls).toEqual([[expect.any(Function), TAG_TX_OPTIONS]]);
    expect(log).toEqual([
      'tx.forUpdate',
      'tx.tag.findUnique',
      'tx.seo.create',
      'tx.tagTranslation.create',
    ]);
  });

  it('createTranslation: P2002 — 400 без ручной уборки Seo', async () => {
    const { tagsService, log } = setup({
      'tag.findUnique': () => ({ id: 't1' }),
      'seo.create': () => ({ id: 7 }),
      'tagTranslation.create': () => {
        throw Object.assign(new Error('dup'), { code: 'P2002' });
      },
    });

    await expect(
      tagsService.createTranslation('t1', {
        language: Language.en,
        name: 'N',
        slug: 'n',
        seo: { metaTitle: 'T' },
      }),
    ).rejects.toThrow('Translation with same (language, slug) already exists');
    expect(rootCalls(log)).toEqual([]);
    expect(log).not.toContain('tx.seo.delete');
  });

  it('createTranslation: тега нет — 404 до всякой записи', async () => {
    const { tagsService, log } = setup();

    await expect(
      tagsService.createTranslation('missing', { language: Language.en, name: 'N', slug: 'n' }),
    ).rejects.toThrow('Tag not found');
    expect(log).toEqual(['tx.forUpdate', 'tx.tag.findUnique']);
  });

  it('updateTranslation: чтения, Seo, редирект и запись — под замком через tx', async () => {
    const { tagsService, log, $transaction, tx, redirects } = setup({
      'tagTranslation.findUnique': () => ({ id: 'tr1', slug: 'old', seoId: 5 }),
    });

    await tagsService.updateTranslation('t1', Language.en, {
      slug: 'new',
      seo: { metaTitle: 'T' },
    });

    expect($transaction.mock.calls).toEqual([[expect.any(Function), TAG_TX_OPTIONS]]);
    expect(log).toEqual([
      'tx.forUpdate',
      'tx.tagTranslation.findUnique',
      'tx.tagTranslation.findFirst',
      'tx.seo.update',
      'tx.tagTranslation.update',
    ]);
    expect(redirects.record).toHaveBeenCalledTimes(1);
    const [redirect, client] = redirects.record.mock.calls[0] as [unknown, unknown];
    expect(redirect).toEqual({
      entityType: 'tag',
      language: Language.en,
      oldSlug: 'old',
      newSlug: 'new',
    });
    // Прокси-клиент сравнивается по ссылке: глубокое сравнение jest его не обходит.
    expect(client === tx).toBe(true);
  });

  it('updateTranslation: новый Seo и снятие Seo тоже идут через tx', async () => {
    const created = setup({
      'tagTranslation.findUnique': () => ({ id: 'tr1', slug: 'old', seoId: null }),
      'seo.create': () => ({ id: 9 }),
    });
    await created.tagsService.updateTranslation('t1', Language.en, { seo: { metaTitle: 'T' } });
    expect(created.log).toContain('tx.seo.create');
    expect(rootCalls(created.log)).toEqual([]);

    const dropped = setup({
      'tagTranslation.findUnique': () => ({ id: 'tr1', slug: 'old', seoId: 5 }),
    });
    await dropped.tagsService.updateTranslation('t1', Language.en, { seo: { metaTitle: null } });
    expect(dropped.log).toContain('tx.seo.delete');
    expect(rootCalls(dropped.log)).toEqual([]);
  });

  it('deleteTranslation: чтение и удаление — под замком через tx', async () => {
    const { tagsService, log, $transaction } = setup({
      'tagTranslation.findUnique': () => ({ id: 'tr1', seoId: 5 }),
    });

    await expect(
      tagsService.deleteTranslation('t1', Language.en, 'admin-actor-1'),
    ).resolves.toEqual({
      success: true,
    });

    expect($transaction.mock.calls).toEqual([[expect.any(Function), TAG_TX_OPTIONS]]);
    expect(log).toEqual([
      'tx.forUpdate',
      'tx.tagTranslation.findUnique',
      'tx.tagTranslation.delete',
      'tx.seo.delete',
    ]);
  });

  /**
   * 🔴 `LEGACY-015`, пачка `T20`, посадка на `LEGACY-036`. Проверять первый
   * аргумент `record` имеет смысл только здесь: в верхнем стенде файла
   * `$transaction` отдаёт колбэку сам `prisma`, и сверка проходит при любом
   * аргументе. Тут `tx` и `root` — разные объекты, и подмена `tx` на
   * `this.prisma` в сервисе роняет тест (`L-016`).
   */
  it('remove: событие журнала пишется тем же tx, что и удаление', async () => {
    const { tagsService, tx, adminAudit, log } = setup({
      'tag.findUnique': () => ({ id: 't1', slug: 'classics' }),
      'tagTranslation.findMany': () => [],
      'tag.delete': () => ({ id: 't1', slug: 'classics' }),
      'tag.findFirst': () => null,
    });

    await tagsService.remove('t1', 'admin-actor-1');

    expect(adminAudit.record).toHaveBeenCalledTimes(1);
    expect(adminAudit.record.mock.calls[0][0]).toBe(tx);
    expect(rootCalls(log)).toEqual([]);
  });

  it('deleteTranslation: событие журнала пишется тем же tx, что и удаление', async () => {
    const { tagsService, tx, adminAudit, log } = setup({
      'tagTranslation.findUnique': () => ({ id: 'tr1', slug: 'klassika', seoId: null }),
    });

    await tagsService.deleteTranslation('t1', Language.en, 'admin-actor-1');

    expect(adminAudit.record).toHaveBeenCalledTimes(1);
    expect(adminAudit.record.mock.calls[0][0]).toBe(tx);
    expect(rootCalls(log)).toEqual([]);
  });

  it('deleteTranslation: перевода нет — успех без записей', async () => {
    const { tagsService, log } = setup();

    await expect(
      tagsService.deleteTranslation('t1', Language.en, 'admin-actor-1'),
    ).resolves.toEqual({
      success: true,
    });
    expect(log).toEqual(['tx.forUpdate', 'tx.tagTranslation.findUnique']);
  });

  it('create: advisory-замок ключа первым, затем проба строки, затем запись', async () => {
    const { tagsService, log, $transaction, tx } = setup();

    await tagsService.create({ name: 'N', slug: 'n-slug', key: 'n-key' });

    expect($transaction.mock.calls).toEqual([[expect.any(Function), TAG_TX_OPTIONS]]);
    expect(log).toEqual(['tx.advisory', 'tx.forUpdate', 'tx.tag.create']);
    const advisoryArgs = (tx.$queryRaw as jest.Mock).mock.calls[0] as unknown[];
    expect(advisoryArgs.slice(1)).toEqual([expect.any(Number), 'n-key']);
  });

  it('путь по id advisory-замка не берёт', async () => {
    const { tagsService, log } = setup({ 'tag.findUnique': () => ({ id: 't1', slug: 's' }) });

    await tagsService.update('t1', { name: 'N' });

    expect(log).not.toContain('tx.advisory');
    expect(log[0]).toBe('tx.forUpdate');
  });

  it('attach и detach открывают транзакцию с явными границами', async () => {
    const { tagsService, $transaction } = setup({
      'bookVersion.findUnique': () => ({ id: 'v1', bookId: 'b1' }),
      'tag.findUnique': () => ({ id: 't1' }),
      'bookVersion.findMany': () => [{ id: 'v1' }],
    });

    await tagsService.attach('v1', 't1');
    await tagsService.detach('v1', 't1');

    expect($transaction).toHaveBeenCalledTimes(2);
    for (const call of $transaction.mock.calls as unknown[][]) {
      expect(call[1]).toEqual(TAG_TX_OPTIONS);
    }
  });
});
