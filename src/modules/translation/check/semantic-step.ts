import { Language, Prisma } from '@prisma/client';
import { LlmError } from '../../llm/llm.errors';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskContext } from '../../llm-worker/llm-task.types';
import { callShaped } from '../llm-shaped-call';
import { StageModels } from '../run/run-models';
import { TranslatedBlock } from '../translate/translate.format';
import { CHECK_REMARKS, CHECK_SEMANTIC_STAGE } from './check.constants';
import { NameEntry, pieceTexts } from './mechanical-check';
import {
  independentModels,
  sampleSentences,
  SEMANTIC_SHAPE,
  SemanticAnswer,
  semanticAnswerOf,
  SemanticInput,
  semanticRequest,
} from './semantic-check';

/**
 * Сверка смысла куска (`F05-5`, шаг 4) - общий шаг, как `translate/translate-step.ts`: запуск
 * (`F05-5`), стыки и итоговая проверка (`F05-6`) зовут его, а не копируют правило семейств.
 */

/** Вход сверки: исходник и перевод по номерам блоков, выборка по сиду. Одно правило на шаг и оценку. */
export function semanticInputOf(input: {
  sourceLanguage: Language;
  targetLanguage: Language;
  source: ReadonlyArray<{ n: number; html: string }>;
  translated: readonly TranslatedBlock[];
  seed: number;
  names: readonly NameEntry[];
}): SemanticInput {
  const { sourceText, translatedText } = pieceTexts(input.source, input.translated);
  return {
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    sourceText,
    translatedText,
    samples: sampleSentences(sourceText, input.seed),
    names: input.names,
  };
}

/**
 * Итог сверки. `not_independent` - модели другого семейства нет, вызова не было;
 * `unavailable` - этап выключили или основная модель потеряла цену посреди запуска (решение
 * арбитра `F05 | F05-5`); `no_provider` - все модели отказали по политике данных, `models` -
 * что передано в вызов; `too_long` - вход не влезает в контекст моделей проверки, вызова нет;
 * `invalid` - ответ не по форме после повтора с замечанием. Прочие отказы
 * модуля LLM (деньги, остановка) уходят вызывающему.
 */
export type SemanticOutcome =
  | { kind: 'not_independent' }
  | { kind: 'unavailable'; code: string }
  | { kind: 'no_provider'; models: StageModels }
  | { kind: 'too_long' }
  | { kind: 'invalid'; costUsd: Prisma.Decimal }
  | { kind: 'answered'; answer: SemanticAnswer; model: string; costUsd: Prisma.Decimal };

/** Отказы, при которых этапа для вызова нет: выключен или основная модель без цены. */
const UNAVAILABLE: readonly string[] = ['LLM_STAGE_DISABLED', 'LLM_NO_PRICE'];

/**
 * Правило семейств - на каждом вызове (`tech.md` §3): модели этапа другого семейства, чем
 * модель, фактически переведшая кусок; переход по 429 идёт только по ним.
 */
export async function checkSemantic(
  llm: LlmService,
  operationId: string,
  input: SemanticInput,
  translatedBy: string,
  stageModels: StageModels,
  ctx: LlmTaskContext,
): Promise<SemanticOutcome> {
  const models = independentModels(
    await llm.stageCallModels(CHECK_SEMANTIC_STAGE, stageModels),
    translatedBy,
  );
  if (models.length === 0) return { kind: 'not_independent' };
  const chosen = { model: models[0], fallbacks: models.slice(1) };
  const request = semanticRequest(input);
  const fit = await llm.stageFit(CHECK_SEMANTIC_STAGE, request, chosen.model, chosen.fallbacks);
  if (!fit.fits) return { kind: 'too_long' };
  try {
    const answer = await callShaped(
      llm,
      operationId,
      CHECK_SEMANTIC_STAGE,
      request,
      SEMANTIC_SHAPE,
      ctx,
      { remarks: CHECK_REMARKS, ...chosen },
    );
    if (!answer.ok) return { kind: 'invalid', costUsd: answer.costUsd };
    return {
      kind: 'answered',
      answer: semanticAnswerOf(answer.value),
      model: answer.model,
      costUsd: answer.costUsd,
    };
  } catch (error) {
    if (error instanceof LlmError && error.code === 'LLM_NO_COMPLIANT_PROVIDER') {
      return { kind: 'no_provider', models: chosen };
    }
    if (error instanceof LlmError && UNAVAILABLE.includes(error.code)) {
      return { kind: 'unavailable', code: error.code };
    }
    throw error;
  }
}
