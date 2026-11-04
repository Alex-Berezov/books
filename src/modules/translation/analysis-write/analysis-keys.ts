import { Language } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import type {
  BookAnalysisCharacterDto,
  BookAnalysisThemeDto,
} from '../../book-analysis/dto/book-analysis-blocks.dto';
import { DossierDemandService } from '../dossier/dossier-demand.service';

/** Анализов других языков книги, из которых выбирается источник ключей. */
const OTHER_ANALYSES_LIMIT = 10;

/**
 * Ключи тем и героев из анализа этой книги на другом языке (`product.md` §2, U7): ключи одинаковые
 * во всех языках, приоритет - анализ исходника (версии, с которой строится досье), иначе самый
 * свежий анализ другого языка. Строки для промпта: `theme <key> - <title>`,
 * `character <key> - <name>`; анализа нет - пусто.
 */
export async function otherLanguageKeys(
  db: PrismaService,
  dossiers: DossierDemandService,
  versionId: string,
  language: Language,
): Promise<string> {
  const { bookId, sourceVersionId } = await dossiers.dossierSourceOf(versionId);
  // Другой язык этой книги (U7), а не «другая версия»: вторая версия того же языка - не источник.
  const otherLanguage = { bookId, language: { not: language } };
  const select = { bookVersionId: true, themes: true, characters: true } as const;
  const listOf = <T>(v: unknown): Array<Partial<T>> =>
    (Array.isArray(v) ? v : []) as Array<Partial<T>>;
  const usable = (r: { themes: unknown; characters: unknown } | null) =>
    r !== null && (listOf(r.themes).length > 0 || listOf(r.characters).length > 0);
  // Исходник - отдельным запросом: в выборке «свежих» его вытеснили бы десять других языков.
  const source = await db.bookAnalysis.findFirst({
    where: { bookVersionId: sourceVersionId, bookVersion: otherLanguage },
    select,
  });
  const others = usable(source)
    ? []
    : await db.bookAnalysis.findMany({
        where: { bookVersion: otherLanguage },
        select,
        orderBy: { updatedAt: 'desc' },
        take: OTHER_ANALYSES_LIMIT,
      });
  const chosen = usable(source) ? source : (others.find(usable) ?? null);
  if (!chosen) return '';
  return [
    ...listOf<BookAnalysisThemeDto>(chosen.themes).flatMap((t) =>
      typeof t.key === 'string' ? [`theme ${t.key} - ${t.title ?? ''}`] : [],
    ),
    ...listOf<BookAnalysisCharacterDto>(chosen.characters).flatMap((c) =>
      typeof c.key === 'string' ? [`character ${c.key} - ${c.name ?? ''}`] : [],
    ),
  ].join('\n');
}
