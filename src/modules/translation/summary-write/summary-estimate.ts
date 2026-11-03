import { Language, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmService } from '../../llm/llm.service';
import { allChapters } from '../chapter-pages';
import { stageEstimatorFor } from '../llm-model-checks';
import { contextUpperChars } from '../translate/translate-estimate';
import {
  SUMMARY_BRIEF_WRITE_STAGE,
  SUMMARY_FULL_WRITE_STAGE,
  SUMMARY_REVIEW_STAGE,
  SUMMARY_SECTION_WRITE_STAGE,
} from './summary-write.constants';
import {
  pipelineUsd,
  sectionSource,
  SectionSource,
  VersionChapter,
  WriteEstimators,
} from './summary-write.parts';

export async function writeEstimators(llm: LlmService): Promise<WriteEstimators> {
  const [section, full, brief, review] = await Promise.all([
    stageEstimatorFor(llm, SUMMARY_SECTION_WRITE_STAGE),
    stageEstimatorFor(llm, SUMMARY_FULL_WRITE_STAGE),
    stageEstimatorFor(llm, SUMMARY_BRIEF_WRITE_STAGE),
    stageEstimatorFor(llm, SUMMARY_REVIEW_STAGE),
  ]);
  return { section, full, brief, review };
}

const versionChapters = (db: PrismaService, versionId: string): Promise<VersionChapter[]> =>
  allChapters(db, versionId, { number: true, title: true, content: true });

/**
 * Разделы сверху, пока плана досье нет (`tech.md` §7): раздел на главу - разделов не больше, чем
 * глав (план группирует главы, `F05-12`). `language` - язык, на котором пишется раздел.
 */
function chapterSourcesOf(
  chapters: readonly VersionChapter[],
  language: Language,
): SectionSource[] {
  return chapters.map((c) =>
    sectionSource(
      { number: c.number, title: c.title, chapters: [c.number], why: '' },
      [c],
      language,
    ),
  );
}

export async function chapterSources(
  db: PrismaService,
  versionId: string,
  language: Language,
): Promise<SectionSource[]> {
  return chapterSourcesOf(await versionChapters(db, versionId), language);
}

/**
 * Строки «Summary» оценки запуска перевода по языкам (`F06-5`; `tech.md` §7): досье на старте
 * запуска обычно ещё нет - сверху, по главам исходника, на языке перевода; вход - плюс потолок
 * досье и глоссария. Та же формула, что у оценки ручного старта без плана
 * (`SummaryWriteService.estimate`). Главы, оценщики этапов и потолок входа читаются один раз на
 * оценку, а не на язык: от языка зависят только названия разделов.
 */
export async function summaryUpperUsd(
  llm: LlmService,
  db: PrismaService,
  sourceVersionId: string,
  languages: readonly Language[],
): Promise<Map<Language, Prisma.Decimal>> {
  const [calls, chapters, extra] = await Promise.all([
    writeEstimators(llm),
    versionChapters(db, sourceVersionId),
    contextUpperChars(llm),
  ]);
  return new Map(
    languages.map((language) => [
      language,
      pipelineUsd(
        calls,
        { language, dossier: null, glossary: null },
        chapterSourcesOf(chapters, language),
        extra,
      ),
    ]),
  );
}
