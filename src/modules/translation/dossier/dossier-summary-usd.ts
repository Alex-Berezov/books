import { Prisma } from '@prisma/client';
import { inputCeilingChars, StageCallEstimator } from '../../llm/llm.service';
import {
  ANSWER_CHARS_PER_TOKEN,
  estimateInputTokens,
  SUMMARY_INPUT_CHARS_PER_TOKEN,
} from '../../llm/openrouter.client';
import {
  dossierListLimits,
  level0GroupsUpperBound,
  summaryCapacity,
  summaryItemChars,
  summaryLevels,
  UPPER_LEVEL_MIN_ITEMS,
  upperLevelFits,
} from './dossier-groups';
import { dossierSummaryRequest, ShapedRequest } from './dossier.prompts';
import { ChapterTitle } from './dossier-demand.types';

/**
 * Вход сводки из `items` ответов в символах (резерв считает символ за токен): каждый ответ - до
 * `maxTokens` токенов с обёрткой элемента и запятой (`SUMMARY_ITEM_WRAPPER_CHARS`), но вызов
 * больше контекста модели не уйдёт (`stageFit`), поэтому сверху - контекст в символах. Без потолка
 * лимит длинной книги раздувался бы на порядки.
 */
function summaryAnswersChars(items: number, call: StageCallEstimator): number {
  const answers = items * summaryItemChars(call.maxTokens);
  return call.contextLength === null
    ? answers
    : Math.min(answers, call.contextLength * ANSWER_CHARS_PER_TOKEN);
}

/**
 * Сверху: сколько стоит сводка из `parts` ответов кусков книги в `chapters` глав. Влезает в
 * контекст и глав не больше `groupChapterCap` - один вызов; иначе - группы уровня 0 (столько,
 * чтобы влез вход и в каждой было не больше `groupChapterCap` глав, `F05-12`), уровни выше по
 * `summaryLevels` и итоговая сводка без списков глав (`F05-Rb`). В группу помещается столько
 * ответов, сколько остаётся от контекста после названий глав и ответа (`summaryCapacity`): на
 * уровне 0 - от входа со списками глав, выше - от входа без них, как у проверки обработчика до
 * оплаты уровня 0; число групп уровня 0 - `level0GroupsUpperBound`, правило упаковки.
 */
export function summaryUsd(
  call: StageCallEstimator,
  titles: ChapterTitle[],
  parts: number,
  chapters: number,
): Prisma.Decimal {
  const limits = dossierListLimits(call.maxTokens);
  const base = dossierSummaryRequest({ chapters: titles, parts: [], limits });
  // Контекст неизвестен или в него не влезает даже ответ - по входу групп нет: сводка не уйдёт
  // вовсе (`DOSSIER_TOO_LONG` без вызова), оценка остаётся одной сводкой, как раньше.
  const capacity = capacityOf(call, base, 1);
  const level0 = level0GroupsUpperBound(parts, chapters, capacity, call.maxTokens);
  if (level0 === 0) return call.estimate(base, summaryAnswersChars(parts, call));
  // Группы делят куски: на все группы уровня 0 вместе - ответы всех кусков, на каждую - свой
  // запрос с названиями глав и свой ответ.
  let usd = call
    .estimate(base)
    .mul(level0 - 1)
    .add(call.estimate(base, parts * summaryItemChars(call.maxTokens)));
  const merged = dossierSummaryRequest({ chapters: titles, parts: [], merge: true, limits });
  const upperCapacity = capacityOf(call, merged, UPPER_LEVEL_MIN_ITEMS);
  const { groupsPerLevel, finalItems } = summaryLevels(level0, upperCapacity);
  for (const groups of groupsPerLevel) {
    usd = usd.add(call.estimate(merged, summaryAnswersChars(upperCapacity, call)).mul(groups));
  }
  return usd.add(call.estimate(merged, summaryAnswersChars(finalItems, call)));
}

/**
 * Сколько ответов влезает во вход вызова с запросом `request` (`summaryCapacity`), не меньше
 * `min`; контекст неизвестен или в него не влезает даже запрос - без предела по входу.
 */
function capacityOf(call: StageCallEstimator, request: ShapedRequest, min: number): number {
  if (call.contextLength === null) return Number.POSITIVE_INFINITY;
  const room =
    inputCeilingChars(call.contextLength, call.maxTokens, SUMMARY_INPUT_CHARS_PER_TOKEN) -
    estimateInputTokens(request);
  if (room <= 0) return Number.POSITIVE_INFINITY;
  // Выше уровня 0 ёмкость меньше двух обработчик не пустит (`upperLevelFits`) - оценка её не считает.
  if (min === UPPER_LEVEL_MIN_ITEMS && !upperLevelFits(room, call.maxTokens)) return min;
  return Math.max(min, summaryCapacity(room, call.maxTokens));
}
