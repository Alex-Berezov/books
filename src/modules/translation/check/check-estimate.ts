import { Language, Prisma } from '@prisma/client';
import { LlmError } from '../../llm/llm.errors';
import { LlmService, StageCallEstimator } from '../../llm/llm.service';
import { stageEstimatorFor } from '../llm-model-checks';
import { ChapterPlan } from '../translate/translate-estimate';
import { chunkBlocks } from '../translate/translate-piece';
import { CHECK_JEV_STAGE, CHECK_SEMANTIC_STAGE, JEV_TEXT_MAX_CHARS } from './check.constants';
import { independentCheckModels } from './check-models';
import { jevRequest } from './jev-check';
import { seamInputOf, seamRequest } from './seam-check';
import { semanticRequest } from './semantic-check';
import { semanticInputOf } from './semantic-step';

/**
 * Сверка смысла в оценке запуска (решения арбитра `F05 | F05-5`, поле `checkUsd`): вызов на кусок
 * моделью, которую возьмёт запуск, - первой другого семейства, чем модель перевода. Повторы
 * перевода и повтор проверки оценка не считает. Оценка сверху по основной модели перевода:
 * переход перевода на запасную другого семейства может сменить и проверяющего. Jev - тоже
 * в `checkUsd`, вызов на кусок, пока этап включён (решение арбитра `F05 | F05-R`, Р9).
 */

/**
 * Вызов Jev сверху - один на оценку: вход - перевод, обрезанный до `JEV_TEXT_MAX_CHARS`; цена -
 * по потолку этапа (`maxPricePerMTok`, Р24) со служебным входом роутера (Р6), как у резерва.
 * `null` - Jev в оценку не входит и старт не блокирует: этап выключен или у модели нет цены
 * (шаг такой Jev пропускает, он необязателен).
 */
export async function jevCallUsd(llm: LlmService): Promise<Prisma.Decimal | null> {
  let call: StageCallEstimator;
  try {
    call = await llm.stageCallEstimator(CHECK_JEV_STAGE);
  } catch (error) {
    if (error instanceof LlmError && error.code === 'LLM_NO_PRICE') return null;
    throw error;
  }
  return call.enabled ? call.estimate(jevRequest('x'.repeat(JEV_TEXT_MAX_CHARS))) : null;
}

/** Jev всех кусков главы: вызов на кусок с переводимым текстом. */
export function chapterJevUsd(perCall: Prisma.Decimal | null, plan: ChapterPlan): Prisma.Decimal {
  if (!perCall) return new Prisma.Decimal(0);
  return perCall.mul(plan.chunks.filter((c) => chunkBlocks(plan.layout, c).length > 0).length);
}

/**
 * Оценщик сверки смысла - модель, которую возьмёт запуск. Модели другого семейства нет - 409
 * `CHECK_MODEL_SAME_FAMILY` (`independentCheckModels`, одно правило с «продолжить»). Этап выключен или основная модель без
 * цены - 409, как у этапа перевода (`stageEstimatorFor`). `NOT_INDEPENDENT` остаётся для перехода
 * переводчика на запасную другого семейства посреди запуска.
 */
export async function checkEstimator(
  llm: LlmService,
  translateModel: string,
): Promise<StageCallEstimator> {
  const [model] = await independentCheckModels(llm, translateModel);
  return stageEstimatorFor(llm, CHECK_SEMANTIC_STAGE, model);
}

/**
 * Сверка смысла всех кусков главы сверху: вход - тот же, что у шага (`semanticInputOf`), перевод
 * в объём `maxTokens` перевода. Выборка - по сиду 0: 3-5 предложений, малая доля входа рядом
 * с исходником и переводом.
 */
export function chapterCheckUsd(
  check: StageCallEstimator,
  plan: ChapterPlan,
  context: { sourceLanguage: Language; targetLanguage: Language; translateMaxTokens: number },
): Prisma.Decimal {
  let total = new Prisma.Decimal(0);
  for (const chunk of plan.chunks) {
    const source = chunkBlocks(plan.layout, chunk);
    // Кусок без переводимых блоков запуск не проверяет (`empty` - `done` без вызова).
    if (source.length === 0) continue;
    const input = semanticInputOf({
      sourceLanguage: context.sourceLanguage,
      targetLanguage: context.targetLanguage,
      source,
      translated: [],
      seed: 0,
      names: [],
    });
    // Перевод - вход сверх запроса в объёме `maxTokens` перевода, без сборки строки.
    total = total.add(check.estimate(semanticRequest(input), context.translateMaxTokens));
  }
  return total;
}

/**
 * Стыки главы моделью сверху (`F05-6`, 6c; решение арбитра `F05 | F05-6`, В4 - в `checkUsd`): вызов
 * на стык, вход - тот же, что у шага (`seamInputOf`); перевода ещё нет - на его месте исходник
 * окна (перевод того же объёма). Глава из одного куска стыков не имеет.
 */
export function chapterSeamUsd(
  check: StageCallEstimator,
  plan: ChapterPlan,
  languages: { sourceLanguage: Language; targetLanguage: Language },
): Prisma.Decimal {
  let total = new Prisma.Decimal(0);
  const asTranslated = (chunk: ChapterPlan['chunks'][number]) => ({
    ...chunk,
    blocks: chunkBlocks(plan.layout, chunk).map((b) => ({ n: b.n, text: b.html })),
  });
  for (let seam = 1; seam < plan.chunks.length; seam++) {
    const input = seamInputOf(
      plan.layout,
      asTranslated(plan.chunks[seam - 1]),
      asTranslated(plan.chunks[seam]),
      languages,
    );
    total = total.add(check.estimate(seamRequest(input)));
  }
  return total;
}
