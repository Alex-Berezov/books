import { NotFoundException } from '@nestjs/common';
import { Language, Prisma } from '@prisma/client';
import { AuthorService } from './author.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SlugRedirectService } from '../slug-redirect/slug-redirect.service';
import { AdminAuditService } from '../../shared/admin-audit/admin-audit.service';

/**
 * F02-2: данные страницы автора — разрешение слагов из блоков (T2/T3), отброс ненайденных
 * «С чего начать», постоянное число запросов, дата перевода при пересоздании и предупреждения
 * сохранения. Заглушка Prisma исполняет условия, которые пишет сервис, над таблицами в памяти:
 * иначе возврат поиска «только на языке страницы» прошёл бы незамеченным.
 */

interface TranslationRow {
  authorId: string;
  language: Language;
  slug: string;
  name: string;
  photoUrl: string | null;
}
interface VersionRow {
  id: string;
  bookId: string;
  language: Language;
  slug: string | null;
  title: string;
  coverImageUrl: string;
  status: 'published' | 'draft';
  bookSlug: string;
}

type Where = Record<string, unknown>;
const inList = (cond: unknown, value: unknown) =>
  cond === undefined ||
  (typeof cond === 'object' && cond !== null && 'in' in cond
    ? (cond as { in: unknown[] }).in.includes(value)
    : cond === value);

function createDb(translations: TranslationRow[], versions: VersionRow[], linkable: string[]) {
  const calls = { authorTranslation: 0, bookVersion: 0, raw: 0 };
  const prisma = {
    authorTranslation: {
      findFirst: jest.fn(),
      findMany: jest.fn<Promise<unknown[]>, [{ where?: Where; orderBy?: unknown; take?: number }]>(
        ({ where = {} }) => {
          calls.authorTranslation += 1;
          return Promise.resolve(
            translations
              .filter(
                (t) =>
                  inList(where.slug, t.slug) &&
                  inList(where.language, t.language) &&
                  inList(where.authorId, t.authorId),
              )
              .map((t) => ({ ...t, author: { birthDate: `born-${t.authorId}`, deathDate: null } })),
          );
        },
      ),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    author: { findUnique: jest.fn(), update: jest.fn() },
    bookVersion: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn<Promise<unknown[]>, [{ where: Where }]>(({ where }) => {
        calls.bookVersion += 1;
        if (Array.isArray(where.OR) && 'slug' in (where.OR[0] as Where)) {
          const wanted = (where.OR as [{ slug: { in: string[] } }])[0].slug.in;
          const bySlug = (where.OR as Where[])[0];
          return Promise.resolve(
            versions
              .filter(
                (v) =>
                  (v.slug &&
                    wanted.includes(v.slug) &&
                    (bySlug.status === undefined || v.status === bySlug.status)) ||
                  wanted.includes(v.bookSlug),
              )
              .map((v) => ({ ...v, book: { slug: v.bookSlug } })),
          );
        }
        // Опубликованные книги автора (`getPublishedBookCards`) в этих тестах не участвуют.
        if (!where.bookId) return Promise.resolve([]);
        return Promise.resolve(
          versions
            .filter(
              (v) =>
                inList(where.bookId, v.bookId) &&
                v.language === where.language &&
                v.status === where.status,
            )
            .map((v) => ({ ...v, book: { slug: v.bookSlug } })),
        );
      }),
    },
    bookRating: { groupBy: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn((strings: unknown) => {
      calls.raw += 1;
      const sql = Array.isArray(strings) ? strings.join('?') : '';
      if (sql.includes('FOR NO KEY UPDATE')) return Promise.resolve([{ id: 'locked' }]);
      return Promise.resolve(
        sql.includes('JOIN "BookVersion"') && sql.includes('"authorId" IN')
          ? linkable.map((authorId) => ({ authorId }))
          : [],
      );
    }),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  return { prisma, calls };
}

const serviceFor = (prisma: unknown) =>
  new AuthorService(
    prisma as PrismaService,
    { record: jest.fn() } as unknown as SlugRedirectService,
    new AdminAuditService(),
  );

const version = (over: Partial<VersionRow>): VersionRow => ({
  id: 'v',
  bookId: 'b',
  language: Language.ru,
  slug: null,
  title: 'T',
  coverImageUrl: 'c.jpg',
  status: 'published',
  bookSlug: 'book',
  ...over,
});

const pageTranslation = (over: Record<string, unknown>) => ({
  id: 'tr',
  authorId: 'tolstoy',
  language: Language.ru,
  slug: 'lev-tolstoy',
  name: 'Лев Толстой',
  biography: null,
  wikidataUrl: null,
  wikipediaUrl: null,
  photoUrl: null,
  quotes: null,
  faq: null,
  similarSlugs: null,
  tagline: null,
  facts: null,
  notableWorks: null,
  startHere: null,
  timeline: null,
  influences: null,
  awards: null,
  adaptations: null,
  funFacts: null,
  sources: null,
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  seo: null,
  author: {
    id: 'tolstoy',
    birthDate: '1828-09-09',
    deathDate: '1910-11-20',
    nativeName: 'Лев Николаевич Толстой',
    photoCredit: { author: 'Prokudin-Gorsky', license: 'Public domain' },
  },
  ...over,
});

describe('AuthorService: данные страницы автора (F02-2)', () => {
  const versions = [
    // «Война и мир»: русская версия со своим слагом, английская — со своим.
    version({
      id: 'wp-ru',
      bookId: 'wp',
      language: Language.ru,
      slug: 'voyna-i-mir',
      title: 'Война и мир',
      bookSlug: 'war-and-peace-book',
    }),
    version({
      id: 'wp-en',
      bookId: 'wp',
      language: Language.en,
      slug: 'war-and-peace',
      title: 'War and Peace',
      bookSlug: 'war-and-peace-book',
    }),
    // «Анна Каренина»: русская версия без своего слага — карточка ведёт на слаг книги.
    version({
      id: 'ak-ru',
      bookId: 'ak',
      language: Language.ru,
      slug: null,
      title: 'Анна Каренина',
      bookSlug: 'anna-karenina',
    }),
    // «Воскресение»: русская версия не опубликована.
    version({
      id: 'rs-ru',
      bookId: 'rs',
      language: Language.ru,
      slug: 'voskresenie',
      status: 'draft',
      bookSlug: 'resurrection',
    }),
  ];
  const translations: TranslationRow[] = [
    {
      authorId: 'dickens',
      language: Language.en,
      slug: 'charles-dickens',
      name: 'Charles Dickens',
      photoUrl: null,
    },
    {
      authorId: 'dickens',
      language: Language.ru,
      slug: 'charlz-dikkens',
      name: 'Чарльз Диккенс',
      photoUrl: 'd.jpg',
    },
    {
      authorId: 'rousseau',
      language: Language.ru,
      slug: 'zhan-zhak-russo',
      name: 'Жан-Жак Руссо',
      photoUrl: null,
    },
  ];

  describe('getPublicBySlug: разрешение слагов', () => {
    it('слаг книги — на языке страницы, через другой язык и по слагу книги; ненайденный — null', async () => {
      const { prisma } = createDb(translations, versions, ['dickens']);
      prisma.authorTranslation.findFirst.mockResolvedValue(
        pageTranslation({
          notableWorks: [
            { title: 'Анна Каренина', year: 1878, bookSlug: 'anna-karenina' },
            { title: 'Война и мир', year: 1869, bookSlug: 'war-and-peace' },
            { title: 'Смерть Ивана Ильича', year: 1886 },
            { title: 'Нет на сайте', bookSlug: 'nowhere' },
          ],
          quotes: [{ text: 'Цитата', source: 'Анна Каренина', bookSlug: 'anna-karenina' }],
        }),
      );

      const result = await serviceFor(prisma).getPublicBySlug('lev-tolstoy', Language.ru);

      expect(result.notableWorks).toEqual([
        {
          title: 'Война и мир',
          year: 1869,
          bookSlug: 'war-and-peace',
          book: { slug: 'voyna-i-mir', title: 'Война и мир', coverUrl: 'c.jpg' },
        },
        {
          title: 'Анна Каренина',
          year: 1878,
          bookSlug: 'anna-karenina',
          book: { slug: 'anna-karenina', title: 'Анна Каренина', coverUrl: 'c.jpg' },
        },
        { title: 'Смерть Ивана Ильича', year: 1886, book: null },
        // Без года — в конце.
        { title: 'Нет на сайте', bookSlug: 'nowhere', book: null },
      ]);
      expect(result.quotes).toEqual([
        {
          text: 'Цитата',
          source: 'Анна Каренина',
          bookSlug: 'anna-karenina',
          book: { slug: 'anna-karenina', title: 'Анна Каренина', coverUrl: 'c.jpg' },
        },
      ]);
    });

    it('черновик со слагом не перехватывает его у опубликованной книги — как адрес книги', async () => {
      const withDraft = [
        ...versions,
        // Книга A: черновик на ru занимает слаг; книга B: тот же слаг опубликован на en.
        version({
          id: 'a-ru',
          bookId: 'a',
          language: Language.ru,
          slug: 'the-trial',
          status: 'draft',
          bookSlug: 'book-a',
        }),
        version({
          id: 'b-en',
          bookId: 'b',
          language: Language.en,
          slug: 'the-trial',
          title: 'The Trial',
          bookSlug: 'book-b',
        }),
        version({
          id: 'b-ru',
          bookId: 'b',
          language: Language.ru,
          slug: 'protsess',
          title: 'Процесс',
          bookSlug: 'book-b',
        }),
      ];
      const { prisma } = createDb(translations, withDraft, []);
      prisma.authorTranslation.findFirst.mockResolvedValue(
        pageTranslation({ startHere: [{ bookSlug: 'the-trial', reason: 'r' }] }),
      );

      const result = await serviceFor(prisma).getPublicBySlug('lev-tolstoy', Language.ru);

      expect(result.startHere.map((s) => s.book.slug)).toEqual(['protsess']);
    });

    it('«С чего начать» без опубликованной книги на языке страницы — запись отброшена', async () => {
      const { prisma } = createDb(translations, versions, []);
      prisma.authorTranslation.findFirst.mockResolvedValue(
        pageTranslation({
          startHere: [
            { bookSlug: 'resurrection', reason: 'черновик' },
            { bookSlug: 'nowhere', reason: 'нет на сайте' },
            { bookSlug: 'voyna-i-mir', reason: 'главное' },
          ],
        }),
      );

      const result = await serviceFor(prisma).getPublicBySlug('lev-tolstoy', Language.ru);

      expect(result.startHere).toEqual([
        {
          bookSlug: 'voyna-i-mir',
          reason: 'главное',
          book: { slug: 'voyna-i-mir', title: 'Война и мир', coverUrl: 'c.jpg' },
        },
      ]);
    });

    it('влияния: слаг другого языка — ссылка на перевод страницы; без книг на языке и ненайденный — null', async () => {
      const { prisma } = createDb(translations, versions, ['dickens']);
      prisma.authorTranslation.findFirst.mockResolvedValue(
        pageTranslation({
          influences: {
            influencedBy: [
              { name: 'Диккенс', authorSlug: 'charles-dickens' },
              { name: 'Руссо', authorSlug: 'zhan-zhak-russo' },
              { name: 'Неизвестный', authorSlug: 'nobody' },
              { name: 'Без слага' },
            ],
          },
        }),
      );

      const result = await serviceFor(prisma).getPublicBySlug('lev-tolstoy', Language.ru);

      expect(result.influences).toEqual({
        influencedBy: [
          {
            name: 'Диккенс',
            authorSlug: 'charles-dickens',
            author: { slug: 'charlz-dikkens', name: 'Чарльз Диккенс' },
          },
          { name: 'Руссо', authorSlug: 'zhan-zhak-russo', author: null },
          { name: 'Неизвестный', authorSlug: 'nobody', author: null },
          { name: 'Без слага', author: null },
        ],
        influenced: [],
      });
    });

    it('сам автор страницы в «Влияниях» — без ссылки', async () => {
      const own: TranslationRow[] = [
        ...translations,
        {
          authorId: 'tolstoy',
          language: Language.ru,
          slug: 'lev-tolstoy',
          name: 'Лев Толстой',
          photoUrl: null,
        },
      ];
      const { prisma } = createDb(own, versions, ['tolstoy']);
      prisma.authorTranslation.findFirst.mockResolvedValue(
        pageTranslation({
          influences: { influenced: [{ name: 'Толстой', authorSlug: 'lev-tolstoy' }] },
        }),
      );

      const result = await serviceFor(prisma).getPublicBySlug('lev-tolstoy', Language.ru);

      expect(result.influences?.influenced[0].author).toBeNull();
    });

    it('пустые блоки — [] и null; поля автора и дата перевода — в ответе', async () => {
      const { prisma } = createDb(translations, versions, []);
      prisma.authorTranslation.findFirst.mockResolvedValue(pageTranslation({}));

      const result = await serviceFor(prisma).getPublicBySlug('lev-tolstoy', Language.ru);

      expect(result).toMatchObject({
        nativeName: 'Лев Николаевич Толстой',
        photoCredit: { author: 'Prokudin-Gorsky', license: 'Public domain' },
        tagline: null,
        facts: null,
        notableWorks: [],
        startHere: [],
        timeline: [],
        influences: null,
        awards: [],
        adaptations: [],
        funFacts: [],
        sources: [],
        quotes: [],
        updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      });
    });

    it('число запросов не растёт с числом слагов', async () => {
      const count = async (n: number) => {
        const { prisma, calls } = createDb(translations, versions, ['dickens']);
        prisma.authorTranslation.findFirst.mockResolvedValue(
          pageTranslation({
            timeline: Array.from({ length: n }, (_, i) => ({
              year: 1850 + i,
              text: `e${i}`,
              bookSlug: i % 2 ? 'voyna-i-mir' : `missing-${i}`,
            })),
            influences: {
              influenced: Array.from({ length: n }, (_, i) => ({
                name: `a${i}`,
                authorSlug: i % 2 ? 'charles-dickens' : `nobody-${i}`,
              })),
            },
            similarSlugs: Array.from({ length: n }, (_, i) => `similar-${i}`),
          }),
        );
        await serviceFor(prisma).getPublicBySlug('lev-tolstoy', Language.ru);
        return { ...calls };
      };

      expect(await count(8)).toEqual(await count(2));
    });
  });

  describe('update: дата перевода (решение арбитра 15.10.2026)', () => {
    const old = (language: Language, over: Record<string, unknown> = {}) => ({
      id: `old-${language}`,
      authorId: 'tolstoy',
      language,
      slug: `slug-${language}`,
      name: `name-${language}`,
      biography: '<p>bio</p>',
      wikidataUrl: null,
      wikipediaUrl: null,
      photoUrl: null,
      quotes: [{ text: 'q' }],
      faq: null,
      similarSlugs: null,
      tagline: 'line',
      facts: null,
      notableWorks: null,
      startHere: null,
      timeline: null,
      influences: null,
      awards: null,
      adaptations: null,
      funFacts: null,
      sources: null,
      seoId: null,
      seo: null,
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...over,
    });
    const dto = (language: Language, over: Record<string, unknown> = {}) => ({
      language,
      slug: `slug-${language}`,
      name: `name-${language}`,
      biography: '<p>bio</p>',
      quotes: [{ text: ' q ' }],
      tagline: 'line',
      ...over,
    });

    it('правка es не меняет дату ru, правка ru — меняет', async () => {
      const { prisma } = createDb([], [], []);
      prisma.author.findUnique.mockResolvedValue({ id: 'tolstoy', translations: [] });
      prisma.authorTranslation.findFirst.mockResolvedValue(null);
      prisma.authorTranslation.findMany.mockImplementation(({ where }: { where: Where }) =>
        Promise.resolve(where.authorId === 'tolstoy' ? [old(Language.ru), old(Language.es)] : []),
      );

      await serviceFor(prisma).update('tolstoy', {
        translations: [dto(Language.ru), dto(Language.es, { tagline: 'changed' })],
      });

      const written = prisma.authorTranslation.create.mock.calls.map(
        ([args]: [{ data: { language: Language; updatedAt: Date } }]) => args.data,
      );
      const ru = written.find((d) => d.language === Language.ru);
      const es = written.find((d) => d.language === Language.es);
      expect(ru?.updatedAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
      expect(es?.updatedAt.getTime()).toBeGreaterThan(new Date('2026-01-01').getTime());
    });

    it('блоки пишутся в хранимом виде: пустое — DbNull, строки обрезаны', async () => {
      const { prisma } = createDb([], [], []);
      prisma.author.findUnique.mockResolvedValue({ id: 'tolstoy', translations: [] });
      prisma.authorTranslation.findFirst.mockResolvedValue(null);

      await serviceFor(prisma).update('tolstoy', {
        nativeName: '  Лев Толстой ',
        photoCredit: null,
        translations: [
          dto(Language.ru, {
            awards: [],
            facts: { birthPlace: '', occupations: [' писатель '] },
          }),
        ],
      });

      const authorData = (
        prisma.author.update.mock.calls[0] as [{ data: Record<string, unknown> }]
      )[0].data;
      expect(authorData.nativeName).toBe('Лев Толстой');
      expect(authorData.photoCredit).toBe(Prisma.DbNull);
      const data = (
        prisma.authorTranslation.create.mock.calls[0] as [{ data: Record<string, unknown> }]
      )[0].data;
      expect(data.awards).toBe(Prisma.DbNull);
      expect(data.timeline).toBe(Prisma.DbNull);
      expect(data.facts).toEqual({ occupations: ['писатель'] });
      expect(data.quotes).toEqual([{ text: 'q' }]);
    });

    it('ответ сохранения несёт предупреждения о ненайденных слагах', async () => {
      const { prisma } = createDb(translations, versions, ['dickens']);
      prisma.author.findUnique.mockResolvedValue({ id: 'tolstoy', translations: [] });
      prisma.authorTranslation.findFirst.mockResolvedValue(null);
      const stored = old(Language.ru, {
        startHere: [
          { bookSlug: 'voyna-i-mir', reason: 'r' },
          { bookSlug: 'resurrection', reason: 'r' },
        ],
        influences: { influencedBy: [{ name: 'Руссо', authorSlug: 'zhan-zhak-russo' }] },
        similarSlugs: ['charles-dickens', 'nobody'],
      });
      const base = prisma.authorTranslation.findMany.getMockImplementation()!;
      prisma.authorTranslation.findMany.mockImplementation((args: { where: Where }) =>
        args.where.authorId === 'tolstoy' ? Promise.resolve([stored]) : base(args),
      );

      const result = await serviceFor(prisma).update('tolstoy', {
        translations: [dto(Language.ru)],
      });

      expect(result?.warnings).toEqual([
        { lang: Language.ru, path: 'startHere[1].bookSlug', slug: 'resurrection' },
        {
          lang: Language.ru,
          path: 'influences.influencedBy[0].authorSlug',
          slug: 'zhan-zhak-russo',
        },
        { lang: Language.ru, path: 'similarSlugs[1]', slug: 'nobody' },
      ]);
    });

    it('сбой подсчёта предупреждений — null, а не пустой список; сохранение не отменяется', async () => {
      const { prisma } = createDb([], [], []);
      prisma.author.findUnique.mockResolvedValue({ id: 'tolstoy', translations: [] });
      prisma.authorTranslation.findFirst.mockResolvedValue(null);
      const base = prisma.authorTranslation.findMany.getMockImplementation()!;
      prisma.authorTranslation.findMany.mockImplementation(
        (args: { where: Where; orderBy?: unknown }) =>
          args.orderBy ? Promise.reject(new Error('db down')) : base(args),
      );

      const result = await serviceFor(prisma).update('tolstoy', {
        translations: [dto(Language.ru)],
      });

      expect(prisma.authorTranslation.create).toHaveBeenCalled();
      expect(result?.warnings).toBeNull();
    });

    /** Запись `update` по языкам: данные `authorTranslation.create`. */
    const writtenData = (prisma: ReturnType<typeof createDb>['prisma']) =>
      prisma.authorTranslation.create.mock.calls.map(
        ([args]: [{ data: Record<string, unknown> & { language: Language; updatedAt: Date } }]) =>
          args.data,
      );
    const withOld = (prisma: ReturnType<typeof createDb>['prisma'], rows: unknown[]) => {
      prisma.author.findUnique.mockResolvedValue({ id: 'tolstoy', translations: [] });
      prisma.authorTranslation.findFirst.mockResolvedValue(null);
      prisma.authorTranslation.findMany.mockImplementation(({ where }: { where: Where }) =>
        Promise.resolve(where.authorId === 'tolstoy' ? rows : []),
      );
    };
    const OLD_DATE = new Date('2026-01-01T00:00:00.000Z');

    it('блока нет в теле — прежнее значение остаётся; явный null — блок очищен (T5)', async () => {
      const { prisma } = createDb([], [], []);
      withOld(prisma, [
        old(Language.ru, {
          timeline: [{ year: 1852, text: 'Детство' }],
          sources: [{ title: 'B', url: 'https://b.org' }],
        }),
      ]);

      await serviceFor(prisma).update('tolstoy', {
        translations: [dto(Language.ru, { sources: null })],
      });

      const [data] = writtenData(prisma);
      expect(data.timeline).toEqual([{ year: 1852, text: 'Детство' }]);
      expect(data.sources).toBe(Prisma.DbNull);
      // Перевод изменился (снят блок) — дата новая.
      expect(data.updatedAt.getTime()).toBeGreaterThan(OLD_DATE.getTime());
    });

    it('старая строка с [] и "" против пустой записи — перевод не менялся, дата прежняя', async () => {
      const { prisma } = createDb([], [], []);
      withOld(prisma, [
        old(Language.ru, { quotes: [], faq: [], similarSlugs: [], tagline: '', wikidataUrl: '' }),
      ]);

      await serviceFor(prisma).update('tolstoy', {
        translations: [dto(Language.ru, { quotes: undefined, tagline: undefined, faq: [] })],
      });

      expect(writtenData(prisma)[0].updatedAt).toEqual(OLD_DATE);
    });

    it('правка только даты SEO-события двигает дату перевода', async () => {
      const { prisma } = createDb([], [], []);
      withOld(prisma, [
        old(Language.ru, { seo: { eventStartDate: new Date('2026-05-01T00:00:00.000Z') } }),
      ]);

      await serviceFor(prisma).update('tolstoy', {
        translations: [dto(Language.ru, { seo: { eventStartDate: '2026-06-01T00:00:00.000Z' } })],
      });

      expect(writtenData(prisma)[0].updatedAt).not.toEqual(OLD_DATE);
    });

    it('правка только SEO двигает дату; язык, которого не было, получает новую', async () => {
      const { prisma } = createDb([], [], []);
      withOld(prisma, [old(Language.ru, { seo: { metaTitle: 'Старый' } })]);

      await serviceFor(prisma).update('tolstoy', {
        translations: [dto(Language.ru, { seo: { metaTitle: 'Новый' } }), dto(Language.fr)],
      });

      const written = writtenData(prisma);
      expect(written.find((d) => d.language === Language.ru)?.updatedAt).not.toEqual(OLD_DATE);
      expect(written.find((d) => d.language === Language.fr)?.updatedAt).not.toEqual(OLD_DATE);
    });

    it('родное имя и подпись, которых нет в теле, не трогаются', async () => {
      const { prisma } = createDb([], [], []);
      withOld(prisma, []);

      await serviceFor(prisma).update('tolstoy', { translations: [dto(Language.ru)] });

      const authorData = (
        prisma.author.update.mock.calls[0] as [{ data: Record<string, unknown> }]
      )[0].data;
      expect(authorData.nativeName).toBeUndefined();
      expect(authorData.photoCredit).toBeUndefined();
    });

    it('предупреждения считают похожих авторов тем же срезом 20, что и страница', async () => {
      const { prisma } = createDb(translations, versions, ['dickens']);
      const similar = [...Array.from({ length: 20 }, () => 'charles-dickens'), 'nobody-after-cut'];
      withOld(prisma, [old(Language.ru, { similarSlugs: similar })]);
      const base = createDb(translations, versions, ['dickens']).prisma.authorTranslation.findMany;
      prisma.authorTranslation.findMany.mockImplementation((args: { where: Where }) =>
        args.where.authorId === 'tolstoy'
          ? Promise.resolve([old(Language.ru, { similarSlugs: similar })])
          : base(args),
      );

      const result = await serviceFor(prisma).update('tolstoy', {
        translations: [dto(Language.ru, { similarSlugs: similar })],
      });

      // 21-й слаг страница не показывает — и предупреждения о нём нет.
      expect(result?.warnings).toEqual([]);
    });
  });

  describe('getPublicBySlug: порядок и индексный путь', () => {
    it('хронология, премии и экранизации — по году, без года в конце', async () => {
      const { prisma } = createDb(translations, versions, []);
      prisma.authorTranslation.findFirst.mockResolvedValue(
        pageTranslation({
          timeline: [
            { year: 1910, text: 'b' },
            { year: 1828, text: 'a' },
          ],
          awards: [{ name: 'без года' }, { name: 'n', year: 1902 }],
          adaptations: [
            { title: 'y', year: 1966, kind: 'film' },
            { title: 'x', year: 1935, kind: 'film' },
          ],
        }),
      );

      const result = await serviceFor(prisma).getPublicBySlug('lev-tolstoy', Language.ru);

      expect(result.timeline.map((e) => e.year)).toEqual([1828, 1910]);
      expect(result.awards.map((a) => a.name)).toEqual(['n', 'без года']);
      expect(result.adaptations.map((a) => a.year)).toEqual([1935, 1966]);
    });

    it('поиск книги по слагу версии идёт с языком — по уникальному индексу', async () => {
      const { prisma } = createDb(translations, versions, []);
      prisma.authorTranslation.findFirst.mockResolvedValue(
        pageTranslation({ startHere: [{ bookSlug: 'voyna-i-mir', reason: 'r' }] }),
      );

      await serviceFor(prisma).getPublicBySlug('lev-tolstoy', Language.ru);

      const lookup = prisma.bookVersion.findMany.mock.calls
        .map(([args]: [{ where: Where }]) => args.where)
        .find((w) => Array.isArray(w.OR) && 'slug' in (w.OR as Where[])[0]);
      expect((lookup?.OR as Where[])[0]).toEqual({
        language: { in: Object.values(Language) },
        slug: { in: ['voyna-i-mir'] },
        status: 'published',
      });
    });
  });

  describe('getPromptInputs', () => {
    const promptDb = () => {
      const { prisma } = createDb(translations, versions, []);
      const author = prisma.author as typeof prisma.author & { findUnique: jest.Mock };
      return { prisma, author };
    };

    it('книги — на все пять языков, авторы — по имени, обрезки нет', async () => {
      const { prisma } = promptDb();
      prisma.author.findUnique.mockResolvedValue({
        id: 'tolstoy',
        birthDate: '1828',
        deathDate: '1910',
        translations: [{ language: Language.ru, name: 'Лев Толстой', slug: 'lev-tolstoy' }],
      });
      prisma.bookVersion.findMany.mockImplementation(({ where }: { where: Where }) =>
        Promise.resolve(
          where.language === Language.ru && where.status === 'published' && !where.bookId
            ? [
                {
                  id: 'wp-ru',
                  bookId: 'wp',
                  slug: 'voyna-i-mir',
                  title: 'Война и мир',
                  author: 'Лев Толстой',
                  authorId: 'tolstoy',
                  coverImageUrl: 'c.jpg',
                  type: 'text',
                  publishedAt: null,
                  _count: { chapters: 1, audioChapters: 2 },
                  categories: [],
                  firstPublishedYear: 1869,
                  book: { slug: 'war-and-peace-book' },
                },
              ]
            : [],
        ),
      );
      prisma.bookVersion.count.mockImplementation(({ where }: { where: Where }) =>
        Promise.resolve(where.language === Language.ru ? 1 : 0),
      );

      const result = await serviceFor(prisma).getPromptInputs('tolstoy');

      expect(result.books.map((b) => b.lang).sort()).toEqual(Object.values(Language).sort());
      expect(result.books.find((b) => b.lang === Language.ru)).toEqual({
        lang: Language.ru,
        items: [
          { title: 'Война и мир', slug: 'voyna-i-mir', firstPublishedYear: 1869, hasAudio: true },
        ],
        total: 1,
      });
      expect(result.authors.map((a) => a.names[0].name)).toEqual([
        'Charles Dickens',
        'Жан-Жак Руссо',
      ]);
      expect(result.authorsTruncated).toBe(false);
    });

    it('404 на несуществующем авторе', async () => {
      const { prisma } = promptDb();
      prisma.author.findUnique.mockResolvedValue(null);
      await expect(serviceFor(prisma).getPromptInputs('none')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('список авторов упёрся в предел — обрезан и помечен', async () => {
      const { prisma } = promptDb();
      prisma.author.findUnique.mockResolvedValue({
        id: 'tolstoy',
        birthDate: null,
        deathDate: null,
        translations: [],
      });
      // Автор на границе предела лежит двумя строками (en и ru): срез одной строки оставил бы
      // его без русского слага — отбрасывается он целиком.
      const rows = Array.from({ length: 10_001 }, (_, i) => {
        const authorIndex = i >= 9_999 ? 9_999 : i;
        return {
          authorId: `a${String(authorIndex).padStart(5, '0')}`,
          language: i === 10_000 ? Language.ru : Language.en,
          name: `Author ${authorIndex}`,
          slug: `author-${authorIndex}-${i}`,
        };
      });
      prisma.authorTranslation.findMany.mockImplementation((args: { take?: number }) =>
        Promise.resolve(args.take !== undefined ? rows.slice(0, args.take) : []),
      );

      const result = await serviceFor(prisma).getPromptInputs('tolstoy');

      expect(result.authorsTruncated).toBe(true);
      // Последний автор до предела мог быть разрезан по языкам — он отброшен целиком.
      expect(result.authors).toHaveLength(9_999);
      expect(result.authors.some((a) => a.names.some((n) => n.name === 'Author 9999'))).toBe(false);
    });

    it('авторы — по имени (английский перевод или первый), а не по id', async () => {
      const { prisma } = promptDb();
      prisma.author.findUnique.mockResolvedValue({
        id: 'tolstoy',
        birthDate: null,
        deathDate: null,
        translations: [],
      });
      prisma.authorTranslation.findMany.mockImplementation((args: { take?: number }) =>
        Promise.resolve(
          args.take !== undefined
            ? [
                { authorId: 'a1', language: Language.en, name: 'Zola', slug: 'zola' },
                { authorId: 'a2', language: Language.en, name: 'Austen', slug: 'austen' },
                { authorId: 'a3', language: Language.ru, name: 'Mann', slug: 'mann' },
              ]
            : [],
        ),
      );

      const result = await serviceFor(prisma).getPromptInputs('tolstoy');

      expect(result.authors.map((a) => a.names[0].name)).toEqual(['Austen', 'Mann', 'Zola']);
    });
  });

  describe('create: предупреждения', () => {
    it('ответ создания несёт ровно ненайденные слаги, найденные не названы', async () => {
      const { prisma } = createDb(translations, versions, ['dickens']);
      const create = jest.fn().mockResolvedValue({
        id: 'new',
        photoCredit: null,
        translations: [],
      });
      (prisma.author as unknown as { create: jest.Mock }).create = create;
      prisma.authorTranslation.findFirst.mockResolvedValue(null);
      const base = prisma.authorTranslation.findMany.getMockImplementation()!;
      prisma.authorTranslation.findMany.mockImplementation((args: { where?: Where }) =>
        args.where?.authorId === 'new'
          ? Promise.resolve([
              {
                language: Language.ru,
                similarSlugs: ['charles-dickens'],
                notableWorks: null,
                startHere: [
                  { bookSlug: 'voyna-i-mir', reason: 'r' },
                  { bookSlug: 'nowhere', reason: 'r' },
                ],
                timeline: null,
                influences: null,
                adaptations: null,
                quotes: null,
              },
            ])
          : base(args),
      );

      const result = await serviceFor(prisma).create({
        translations: [{ language: Language.ru, name: 'Лев Толстой', slug: 'lev-tolstoy' }],
      });

      expect(result.warnings).toEqual([
        { lang: Language.ru, path: 'startHere[1].bookSlug', slug: 'nowhere' },
      ]);
    });
  });
});
