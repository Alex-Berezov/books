import { Language } from '@prisma/client';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskContext } from '../../llm-worker/llm-task.types';
import { StageModels } from '../run/run-models';
import { TranslatedBlock } from '../translate/translate.format';
import { CHECK_SEMANTIC_STAGE } from './check.constants';
import { callIndependent, IndependentOutcome } from './independent-call';
import { NameEntry, pieceTexts } from './mechanical-check';
import {
  sampleSentences,
  SEMANTIC_SHAPE,
  SemanticAnswer,
  semanticAnswerOf,
  SemanticInput,
  semanticRequest,
} from './semantic-check';

/**
 * Сверка смысла куска (`F05-5`, шаг 4) - общий шаг, как `translate/translate-step.ts`. Правило
 * семейств - общий вызов `callIndependent` (`independent-call.ts`): его зовут и стыки, и итоговая
 * проверка (`F05-6`).
 */

export type SemanticOutcome = IndependentOutcome<SemanticAnswer>;

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

/** Сверка смысла куска: модели другого семейства, чем модель, фактически переведшая кусок. */
export function checkSemantic(
  llm: LlmService,
  operationId: string,
  input: SemanticInput,
  translatedBy: string,
  stageModels: StageModels,
  ctx: LlmTaskContext,
): Promise<SemanticOutcome> {
  return callIndependent(
    llm,
    operationId,
    CHECK_SEMANTIC_STAGE,
    semanticRequest(input),
    SEMANTIC_SHAPE,
    semanticAnswerOf,
    translatedBy,
    stageModels,
    ctx,
  );
}
