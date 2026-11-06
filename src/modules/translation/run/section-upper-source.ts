import { PrismaService } from '../../../prisma/prisma.service';
import { LlmService } from '../../llm/llm.service';
import { allChapters } from '../chapter-pages';
import { contextUpperChars } from '../translate/translate-estimate';

/**
 * Вход строк разделов оценки запуска перевода - Summary (`F06-5`) и Analysis (`F07-3b`): версии
 * языка ещё нет, оценка - сверху по исходнику. Главы с текстом, потолок входа на досье и глоссарий,
 * название и автор исходника читаются один раз на оценку, а не на раздел и не на язык (решение
 * арбитра `F07 | F07-3b`, В1).
 */
export interface SectionUpperSource {
  chapters: Array<{ number: number; title: string; content: string }>;
  /** Потолок входа сверх промпта, пока досье и глоссария нет. */
  extra: number;
  title: string;
  author: string;
}

export async function loadSectionUpperSource(
  llm: LlmService,
  db: PrismaService,
  sourceVersionId: string,
): Promise<SectionUpperSource> {
  const [version, chapters, extra] = await Promise.all([
    db.bookVersion.findUnique({
      where: { id: sourceVersionId },
      select: { title: true, author: true },
    }),
    allChapters(db, sourceVersionId, { number: true, title: true, content: true }),
    contextUpperChars(llm),
  ]);
  return { chapters, extra, title: version?.title ?? '', author: version?.author ?? '' };
}
