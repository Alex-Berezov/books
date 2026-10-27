import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Language, type PrismaClient } from '@prisma/client';
import {
  type EnsureRights,
  pruneAcceptanceVersions,
  seedSeoRobots,
  upsertAcceptanceBook,
  upsertAcceptanceChapters,
  upsertAcceptanceVersion,
} from './seed-acceptance';

/**
 * Книга-образец приёмки автоперевода (`F05-9`, `books-app-docs/features/F05-book-translation/product.md`
 * §7): Joseph Conrad, «Heart of Darkness», части I и II - общественное достояние, источник
 * и разметка - `prisma/fixtures/f05-sample/README.md` (решение арбитра `F05 | F05-9`).
 *
 * Одна версия - `en`, исходник перевода: версий на других языках у образца нет, иначе они закрыли
 * бы свои языки в окне запуска (§7 п.10). Повторный сид снимает версии других языков, созданные
 * переводом, и переписывает поля и главы `en`; досье книги, запуски и заготовки на `en` остаются.
 * Версия - черновик под редакторским `noindex`: на сайт образец не выходит. Книга вне
 * `SEO_CATALOG_BOOKS` - числа каталога в `test/seed-dataset.e2e-spec.ts` от неё не меняются.
 */
export const TRANSLATION_SAMPLE_SLUG = 'translation-acceptance-sample';

const SAMPLE_DIR = join(__dirname, 'fixtures', 'f05-sample');
const CHAPTERS = [1, 2];
const TITLES = ['I', 'II'];

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Текст главы Gutenberg в разметку читалки: абзацы - через пустую строку, переносы внутри абзаца -
 * пробелы, курсив `_слово_` - `<em>`.
 */
export function sampleChapterHtml(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph !== '')
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/_([^_]+)_/g, '<em>$1</em>')}</p>`)
    .join('\n');
}

export async function seedTranslationSample(
  prisma: PrismaClient,
  ensureRights: EnsureRights,
): Promise<void> {
  // Текст - до книги: без файла образца книга с цепочкой прав не заводится вполовину
  // (`upsertAcceptanceBook` пишет вне транзакции).
  const chapters = CHAPTERS.map((number) =>
    sampleChapterHtml(readFileSync(join(SAMPLE_DIR, `chapter-${number}.txt`), 'utf8')),
  );
  const rights = await upsertAcceptanceBook(prisma, ensureRights, TRANSLATION_SAMPLE_SLUG, {
    title: 'Heart of Darkness',
    summaryRu: 'Служебная книга-образец приёмки автоперевода (F05)',
  });

  await prisma.$transaction(
    async (tx) => {
      await pruneAcceptanceVersions(tx, rights.bookId, [Language.en]);
      const { id: versionId, seoId } = await upsertAcceptanceVersion(tx, rights, {
        slug: TRANSLATION_SAMPLE_SLUG,
        language: Language.en,
        title: 'Heart of Darkness',
        description:
          'Marlow tells his friends on the Thames how he took a river steamer into Africa ' +
          'in search of Kurtz, an ivory agent of legendary reputation.',
        status: 'draft',
        // Свои автор и язык оригинала: по ним конвейер выбирает исходник (D8) и переводит автора.
        author: 'Joseph Conrad',
        originalLanguage: 'English',
      });
      await upsertAcceptanceChapters(tx, versionId, CHAPTERS, (number) => ({
        title: TITLES[number - 1],
        content: chapters[number - 1],
      }));
      await seedSeoRobots(tx, { id: versionId, seoId }, true);
    },
    { timeout: 60_000, maxWait: 15_000 },
  );
}
