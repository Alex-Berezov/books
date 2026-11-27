import { Language, Prisma } from '@prisma/client';
import { EMPTY_BOOK_ANALYSIS, StoredBookAnalysis } from '../../book-analysis/book-analysis-data';
import { BOOK_ANALYSIS_LIMITS } from '../../book-analysis/dto/book-analysis-blocks.dto';
import { BOOK_WORLD_LIMITS } from '../../book-world/dto/book-world-blocks.dto';
import { LlmService } from '../../llm/llm.service';
import { withChapterText } from '../content-draft/content-draft.text';
import { stageEstimatorFor } from '../llm-model-checks';
import { SectionUpperSource } from '../run/section-upper-source';
import { hasWorldPairExample } from './examples';
import { dossierStepsUpperBound } from './world-write.dossier-entities';
import { eventStepsUpperBound, type KnownWorldEvent } from './world-write.events';
import { placeStepsUpperBound } from './world-write.places';
import {
  WORLD_EXTERNAL_WRITE_STAGE,
  WORLD_PAGE_WRITE_STAGE,
  WORLD_PAIR_WRITE_STAGE,
  WORLD_REVIEW_STAGE,
  WORLD_EVENT_KEY_MAX,
  WORLD_SELECT_STAGE,
} from './world-write.constants';
import { pairStepsUpperBound, WorldEstimators, worldPipelineUsd } from './world-write.steps';

/** Оценщики этапов хода мира - общие у оценки ручного старта и оценки запуска (`F08-9b`). */
export async function worldEstimators(llm: LlmService): Promise<WorldEstimators> {
  const [select, page, external, pair, review] = await Promise.all([
    stageEstimatorFor(llm, WORLD_SELECT_STAGE),
    stageEstimatorFor(llm, WORLD_PAGE_WRITE_STAGE),
    stageEstimatorFor(llm, WORLD_EXTERNAL_WRITE_STAGE),
    stageEstimatorFor(llm, WORLD_PAIR_WRITE_STAGE),
    stageEstimatorFor(llm, WORLD_REVIEW_STAGE),
  ]);
  return { select, page, external, pair, review };
}

/**
 * Анализ-подставка оценки запуска: героев столько, сколько допускает анализ
 * (`BOOK_ANALYSIS_LIMITS.characters`), все `main` - каждый получает страницу (решение арбитра
 * `F08 | F08-9b`, Q5: верхняя граница не занижает цену).
 */
export function upperWorldAnalysis(): StoredBookAnalysis {
  const characters = Array.from({ length: BOOK_ANALYSIS_LIMITS.characters }, (_, i) => ({
    key: `character-${i + 1}`,
    name: `Character ${i + 1}`,
    role: 'main' as const,
  }));
  return { ...EMPTY_BOOK_ANALYSIS, characters };
}

/**
 * События других версий - подставка оценки запуска (`F08-13b-2`, Q9): мира версий до старта не знаем -
 * столько, сколько отдаёт запрос хода (`knownWorldEvents`, предел `BOOK_WORLD_LIMITS.entities`),
 * ключ и название в пределе: верхняя граница входа выбора не занижает цену.
 */
export function upperKnownEvents(): KnownWorldEvent[] {
  return Array.from({ length: BOOK_WORLD_LIMITS.entities }, (_, i) => ({
    key: `event-${i + 1}-`.padEnd(WORLD_EVENT_KEY_MAX, 'x'),
    name: `Event ${i + 1} `.padEnd(BOOK_WORLD_LIMITS.name, 'x'),
  }));
}

/**
 * Строки «World» оценки запуска перевода по языкам (`F08-9b`; `tech.md` §5; решение арбитра
 * `F08 | F08-9b`, Q5): версии языка и её анализа ещё нет - сверху, по главам, названию и автору
 * исходника, на языке перевода, героев - предел анализа (`upperWorldAnalysis`), пар - верхняя граница
 * (`pairStepsUpperBound`) при эталоне пары языка, досье и глоссария нет - вход плюс их потолок.
 * Та же функция, что у оценки ручного старта (`worldPipelineUsd`); вход общий с Summary и Analysis
 * (`SectionUpperSource`, один раз на оценку).
 */
export async function worldUpperUsd(
  llm: LlmService,
  source: SectionUpperSource,
  languages: readonly Language[],
  originalLanguage: string,
): Promise<Map<Language, Prisma.Decimal>> {
  const calls = await worldEstimators(llm);
  const chapters = withChapterText(source.chapters);
  const analysis = upperWorldAnalysis();
  const heroes = analysis.characters?.length ?? 0;
  return new Map(
    languages.map((language) => {
      const context = {
        language,
        dossier: null,
        glossary: null,
        bookTitle: source.title,
        author: source.author,
        originalLanguage,
        chapters,
        analysis,
        entities: new Map(),
        names: { titles: [source.title], authors: [source.author] },
        knownEvents: eventStepsUpperBound(language) > 0 ? upperKnownEvents() : [],
      };
      return [
        language,
        worldPipelineUsd(
          calls,
          context,
          source.extra,
          {
            pairs: pairStepsUpperBound(heroes, hasWorldPairExample(language)),
            // Места (`F08-12b`): досье до старта нет - потолок `WORLD_PLACES_MAX` на языке с эталоном места.
            places: placeStepsUpperBound(null, language),
            // Предметы и понятия (`F08-13b`, Q9): так же - потолок своего типа на языке с его эталоном.
            objects: dossierStepsUpperBound(null, language, 'object'),
            terms: dossierStepsUpperBound(null, language, 'term'),
            // События (`F08-13b-2`, Q9): потолок на языке с эталоном события.
            events: eventStepsUpperBound(language),
          },
          context,
        ),
      ] as const;
    }),
  );
}
