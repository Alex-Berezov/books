import { Language, Prisma } from '@prisma/client';
import { EMPTY_BOOK_ANALYSIS } from '../../book-analysis/book-analysis-data';
import { LlmService } from '../../llm/llm.service';
import { withChapterText } from '../content-draft/content-draft.text';
import { stageEstimatorFor } from '../llm-model-checks';
import { SectionUpperSource } from '../run/section-upper-source';
import {
  ANALYSIS_CAST_WRITE_STAGE,
  ANALYSIS_EXTERNAL_WRITE_STAGE,
  ANALYSIS_MEANING_WRITE_STAGE,
  ANALYSIS_QUOTES_WRITE_STAGE,
  ANALYSIS_READER_WRITE_STAGE,
  ANALYSIS_REVIEW_STAGE,
} from './analysis-write.constants';
import { AnalysisEstimators, analysisPipelineUsd } from './analysis-write.steps';

/** Оценщики этапов хода анализа - общие у оценки ручного старта и оценки запуска (`F07-3b`). */
export async function analysisEstimators(llm: LlmService): Promise<AnalysisEstimators> {
  const [cast, quotes, meaning, reader, external, review] = await Promise.all([
    stageEstimatorFor(llm, ANALYSIS_CAST_WRITE_STAGE),
    stageEstimatorFor(llm, ANALYSIS_QUOTES_WRITE_STAGE),
    stageEstimatorFor(llm, ANALYSIS_MEANING_WRITE_STAGE),
    stageEstimatorFor(llm, ANALYSIS_READER_WRITE_STAGE),
    stageEstimatorFor(llm, ANALYSIS_EXTERNAL_WRITE_STAGE),
    stageEstimatorFor(llm, ANALYSIS_REVIEW_STAGE),
  ]);
  return { cast, quotes, meaning, reader, external, review };
}

/**
 * Строки «Analysis» оценки запуска перевода по языкам (`F07-3b`; `tech.md` §6; решение арбитра
 * `F07 | F07-3b`, В1): версии языка ещё нет - сверху, по главам, названию и автору исходника, на
 * языке перевода, все блоки пусты (каждый шаг пишет всё), досье и глоссария нет - вход плюс их
 * потолок. Та же функция, что у оценки ручного старта (`analysisPipelineUsd`); главы с текстом -
 * тем же фильтром, что `estimateOf`. Вход общий с Summary (`SectionUpperSource`, один раз на оценку).
 */
export async function analysisUpperUsd(
  llm: LlmService,
  source: SectionUpperSource,
  languages: readonly Language[],
): Promise<Map<Language, Prisma.Decimal>> {
  const calls = await analysisEstimators(llm);
  const withText = withChapterText(source.chapters);
  return new Map(
    languages.map((language) => [
      language,
      analysisPipelineUsd(
        calls,
        {
          language,
          dossier: null,
          glossary: null,
          bookTitle: source.title,
          author: source.author,
          stored: EMPTY_BOOK_ANALYSIS,
          merged: {},
          chapters: withText,
          otherKeys: '',
        },
        source.extra,
      ),
    ]),
  );
}
