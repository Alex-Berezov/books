import { Language, type Prisma, type PrismaClient } from '@prisma/client';
import {
  type EnsureRights,
  pruneAcceptanceVersions,
  upsertAcceptanceBook,
  upsertAcceptanceChapters,
  upsertAcceptanceVersion,
} from './seed-acceptance';

/**
 * Книги приёмки вариантов пересказа (`F04-4`, `books-front/e2e/book-summary-variants.spec.ts`,
 * `books-app-docs/features/F04-summary-variants/product.md` §9).
 *
 * Книги служебные и названы так, чтобы это было видно (решение арбитра `F03 | F03-4`, В1, повторено
 * для F04 решением `F04 | F04-4`, Q3): тексты - служебные, у каждого раздела свой, чтобы страница
 * раздела отличалась от соседней. Претензий правообладателя здесь нет (решение `F04 | F04-4`, Q1):
 * 451 разделов держат `test/book-summary-sections.e2e-spec.ts` и `__tests__/middleware.test.ts`.
 * Книги вне `SEO_CATALOG_BOOKS` - точные числа каталога в `test/seed-dataset.e2e-spec.ts`
 * от них не меняются.
 *
 * - `full` - полный, очень краткий и разделы на пяти языках с разной разбивкой (en 3, es 2, fr 3,
 *   pt 2, ru 4), главы 1-3; у английского третий раздел ведёт на несуществующую главу 99;
 * - `only-full` - только полный пересказ (`en`);
 * - `brief-only` - полный и очень краткий, без разделов (`en`);
 * - `sections-only` - полный и два раздела, без очень краткого (`en`); у той же книги `es` со своим
 *   слагом версии (`summary-acceptance-sections-only-es`, один раздел) и `ru` без пересказа - для
 *   переключателя языка: `ru` в нём нет, `es` ведёт на слаг своей версии;
 * - `no-full` - два раздела без полного пересказа (`en`): страницы нет, разделы в админке есть;
 * - `noindex` - как `full` для `en`, но книга закрыта редактором от индекса;
 * - `no-chapters` - версия без текста книги, разделы указывают на главу 1 (`en`);
 * - `draft` - версия-черновик с полным набором (`en`).
 *
 * Даты правки записаны явно и в прошлом: e2e сверяет `dateModified` разметки и `lastmod` карты
 * сайта с ними, а не с «сейчас» (`product.md` §2 п.6, §9 п.8).
 */

/** Слаги книг приёмки: один слаг на все языки версии (слаг уникален в пределах языка). */
export const SUMMARY_ACCEPTANCE = {
  full: 'summary-acceptance-full',
  onlyFull: 'summary-acceptance-only-full',
  briefOnly: 'summary-acceptance-brief-only',
  sectionsOnly: 'summary-acceptance-sections-only',
  sectionsOnlyEs: 'summary-acceptance-sections-only-es',
  noFull: 'summary-acceptance-no-full',
  noindex: 'summary-acceptance-noindex',
  noChapters: 'summary-acceptance-no-chapters',
  draft: 'summary-acceptance-draft',
} as const;

/** Дата правки пересказа в сиде: `BookSummary.updatedAt` (полный и очень краткий вместе). */
export const SUMMARY_ACCEPTANCE_SUMMARY_DATE = new Date('2026-03-10T09:30:00.000Z');
/** Правка текста раздела, номер которого потом сменился (`movedAt`): дата раздела - более поздняя. */
const SUMMARY_ACCEPTANCE_SECTION_DATE = new Date('2026-01-06T08:00:00.000Z');
export const SUMMARY_ACCEPTANCE_SECTION_MOVED_DATE = new Date('2026-02-20T08:00:00.000Z');

/** Служебные строки на язык. */
interface Words {
  title: string;
  service: string;
  brief: string;
  part: string;
  chapter: string;
}

const WORDS: Record<Language, Words> = {
  en: {
    title: 'Summary acceptance book',
    service: 'Service text of the acceptance summary.',
    brief: 'Very brief service text of the acceptance summary.',
    part: 'Part',
    chapter: 'Chapter',
  },
  es: {
    title: 'Libro de aceptación del resumen',
    service: 'Texto de servicio del resumen de aceptación.',
    brief: 'Texto de servicio muy breve del resumen de aceptación.',
    part: 'Parte',
    chapter: 'Capítulo',
  },
  fr: {
    title: 'Livre de recette du résumé',
    service: 'Texte de service du résumé de recette.',
    brief: 'Texte de service très bref du résumé de recette.',
    part: 'Partie',
    chapter: 'Chapitre',
  },
  pt: {
    title: 'Livro de aceitação do resumo',
    service: 'Texto de serviço do resumo de aceitação.',
    brief: 'Texto de serviço muito breve do resumo de aceitação.',
    part: 'Parte',
    chapter: 'Capítulo',
  },
  ru: {
    title: 'Книга приёмки пересказа',
    service: 'Служебный текст пересказа приёмки.',
    brief: 'Очень краткий служебный текст пересказа приёмки.',
    part: 'Часть',
    chapter: 'Глава',
  },
};

interface AcceptanceSection {
  /** Номер главы читалки для «Читать эту главу»; `null` - не указана. */
  readerChapter: number | null;
  /** Правка текста и смена номера; без `updatedAt` - дата пересказа сида, без `movedAt` - номер не менялся. */
  updatedAt?: Date;
  movedAt?: Date;
}

interface AcceptanceVersion {
  language: Language;
  /** Слаг версии, если он не совпадает со слагом книги. */
  slug?: string;
  /** Номера глав версии; пусто - версия без текста книги. */
  chapters: number[];
  status?: 'draft';
  /** Полный пересказ с видимым текстом; без него разделы не публикуются. */
  summary: boolean;
  brief: boolean;
  sections: AcceptanceSection[];
  /** Книга закрыта редактором от индекса (`Seo.robots`). */
  noindex?: boolean;
}

interface AcceptanceBook {
  slug: string;
  versions: AcceptanceVersion[];
}

const ALL_CHAPTERS = [1, 2, 3];
const plain = (readerChapter: number | null): AcceptanceSection => ({ readerChapter });

/** Набор приёмки. Экспортирован для сверки в `test/seed-dataset.e2e-spec.ts`. */
export function summaryAcceptanceBooks(): AcceptanceBook[] {
  const withSections = (
    language: Language,
    sections: AcceptanceSection[],
    over: Partial<AcceptanceVersion> = {},
  ): AcceptanceVersion => ({
    language,
    chapters: ALL_CHAPTERS,
    summary: true,
    brief: true,
    sections,
    ...over,
  });
  return [
    {
      slug: SUMMARY_ACCEPTANCE.full,
      versions: [
        // Второй раздел английской версии сменил номер после правки текста: дата раздела свежее.
        withSections(Language.en, [
          { readerChapter: 1, updatedAt: SUMMARY_ACCEPTANCE_SECTION_DATE },
          {
            readerChapter: 2,
            updatedAt: SUMMARY_ACCEPTANCE_SECTION_DATE,
            movedAt: SUMMARY_ACCEPTANCE_SECTION_MOVED_DATE,
          },
          plain(99),
        ]),
        withSections(Language.es, [plain(2), plain(null)]),
        withSections(Language.fr, [plain(1), plain(null), plain(3)]),
        withSections(Language.pt, [plain(null), plain(null)]),
        withSections(Language.ru, [plain(1), plain(2), plain(3), plain(null)]),
      ],
    },
    {
      slug: SUMMARY_ACCEPTANCE.onlyFull,
      versions: [withSections(Language.en, [], { brief: false })],
    },
    {
      slug: SUMMARY_ACCEPTANCE.briefOnly,
      versions: [withSections(Language.en, [])],
    },
    {
      slug: SUMMARY_ACCEPTANCE.sectionsOnly,
      versions: [
        withSections(Language.en, [plain(1), plain(2)], { brief: false }),
        withSections(Language.es, [plain(1)], {
          brief: false,
          slug: SUMMARY_ACCEPTANCE.sectionsOnlyEs,
        }),
        withSections(Language.ru, [], { summary: false, brief: false }),
      ],
    },
    {
      slug: SUMMARY_ACCEPTANCE.noFull,
      versions: [withSections(Language.en, [plain(1), plain(2)], { summary: false, brief: false })],
    },
    {
      slug: SUMMARY_ACCEPTANCE.noindex,
      versions: [withSections(Language.en, [plain(1), plain(2)], { noindex: true })],
    },
    {
      slug: SUMMARY_ACCEPTANCE.noChapters,
      versions: [withSections(Language.en, [plain(1), plain(2)], { chapters: [], brief: false })],
    },
    {
      slug: SUMMARY_ACCEPTANCE.draft,
      versions: [withSections(Language.en, [plain(1), plain(2)], { status: 'draft' })],
    },
  ];
}

/** Название раздела; у каждого номера оно своё. */
export const sectionTitle = (language: Language, number: number): string =>
  `${WORDS[language].part} ${number}`;

/** Текст раздела: служебная фраза, название и номер - страницы разделов не совпадают между собой. */
export const sectionText = (language: Language, number: number): string =>
  `<p>${WORDS[language].service} ${sectionTitle(language, number)}.</p>`;

/** Полный и очень краткий пересказ книги приёмки: на язык один текст. */
const fullText = (language: Language): string => `<p>${WORDS[language].service}</p>`;
export const briefText = (language: Language): string => `<p>${WORDS[language].brief}</p>`;

const chapterContent = (words: Words, number: number): string =>
  `<p>${words.service} ${words.chapter} ${number}.</p>`;

/**
 * Заводит книги приёмки вариантов пересказа. Идемпотентно: книга по слагу, версия по
 * `(bookId, language)`, главы по `(bookVersionId, number)`, пересказ по `bookVersionId`, разделы
 * по `(bookVersionId, number)`. Строки, ушедшие из набора, снимаются той же транзакцией; удаление
 * идёт только по версиям книг приёмки - чужих строк здесь нет.
 */
export async function seedSummaryAcceptance(
  prisma: PrismaClient,
  ensureRights: EnsureRights,
): Promise<void> {
  for (const bookSeed of summaryAcceptanceBooks()) {
    const rights = await upsertAcceptanceBook(prisma, ensureRights, bookSeed.slug, {
      title: WORDS.en.title,
      summaryRu: 'Служебная книга приёмки вариантов пересказа',
    });

    await prisma.$transaction(
      async (tx) => {
        // Версия книги приёмки на языке вне набора снимается вместе со своими строками (каскад).
        await pruneAcceptanceVersions(
          tx,
          rights.bookId,
          bookSeed.versions.map((seedVersion) => seedVersion.language),
        );
        // Гео-правил в наборе нет: правило, поставленное руками на книгу приёмки или её версию,
        // закрыло бы разделы и сломало приёмку - снимается, как в `seed-analyses.ts`.
        await tx.geoBlockRule.deleteMany({
          where: { OR: [{ bookId: rights.bookId }, { bookVersion: { bookId: rights.bookId } }] },
        });

        for (const seedVersion of bookSeed.versions) {
          const words = WORDS[seedVersion.language];
          const { id: versionId, seoId } = await upsertAcceptanceVersion(tx, rights, {
            slug: seedVersion.slug ?? bookSeed.slug,
            language: seedVersion.language,
            title: words.title,
            description: words.service,
            status: seedVersion.status,
          });

          await upsertAcceptanceChapters(tx, versionId, seedVersion.chapters, (number) => ({
            title: `${words.chapter} ${number}`,
            content: chapterContent(words, number),
          }));

          await seedSeoRobots(tx, { id: versionId, seoId }, seedVersion.noindex === true);

          if (seedVersion.summary) {
            const summary = {
              summary: fullText(seedVersion.language),
              hasText: true,
              brief: seedVersion.brief ? briefText(seedVersion.language) : null,
              briefHasText: seedVersion.brief,
              updatedAt: SUMMARY_ACCEPTANCE_SUMMARY_DATE,
            };
            await tx.bookSummary.upsert({
              where: { bookVersionId: versionId },
              update: summary,
              create: { ...summary, bookVersionId: versionId },
              select: { id: true },
            });
          } else {
            await tx.bookSummary.deleteMany({ where: { bookVersionId: versionId } });
          }

          // Разделы: номера подряд с 1. Номера вне 1..N (в том числе отрицательные от оборванного
          // сдвига, `CHECK` на номер нет) снимаются, остальные пишутся целиком.
          await tx.bookSummarySection.deleteMany({
            where: {
              bookVersionId: versionId,
              number: { notIn: seedVersion.sections.map((_, index) => index + 1) },
            },
          });
          for (const [index, section] of seedVersion.sections.entries()) {
            const number = index + 1;
            const data = {
              title: sectionTitle(seedVersion.language, number),
              text: sectionText(seedVersion.language, number),
              readerChapter: section.readerChapter,
              updatedAt: section.updatedAt ?? SUMMARY_ACCEPTANCE_SUMMARY_DATE,
              movedAt: section.movedAt ?? null,
            };
            await tx.bookSummarySection.upsert({
              where: { bookVersionId_number: { bookVersionId: versionId, number } },
              update: data,
              create: { ...data, bookVersionId: versionId, number },
              select: { id: true },
            });
          }
        }
      },
      { timeout: 60_000, maxWait: 15_000 },
    );
  }
}

/**
 * Редакторский `noindex` книги: `robots` строки `Seo` версии. Версия вне `noindex` набора получает
 * `robots: null` (индексируется) - ручная правка или прежний набор сбрасываются, как остальное.
 */
async function seedSeoRobots(
  tx: Prisma.TransactionClient,
  version: { id: string; seoId: number | null },
  noindex: boolean,
): Promise<void> {
  const robots = noindex ? 'noindex, follow' : null;
  if (version.seoId !== null) {
    await tx.seo.update({ where: { id: version.seoId }, data: { robots } });
    return;
  }
  if (!noindex) return;
  const seo = await tx.seo.create({ data: { robots }, select: { id: true } });
  await tx.bookVersion.update({ where: { id: version.id }, data: { seoId: seo.id } });
}
