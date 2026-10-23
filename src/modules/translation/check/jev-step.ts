import { LlmError } from '../../llm/llm.errors';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskContext } from '../../llm-worker/llm-task.types';
import { callShaped } from '../llm-shaped-call';
import { passesThroughOptional } from '../pause-by-failure';
import { StageModels } from '../run/run-models';
import { CHECK_JEV_STAGE, CHECK_REMARKS } from './check.constants';
import { JevOutcome } from './chunk-verdict';
import { JEV_SHAPE, jevAnswerOf, jevRequest } from './jev-check';

/**
 * Язык перевода по Jev (карточка `F05-5`, шаг 5) - общий шаг, как сверка смысла
 * (`semantic-step.ts`): выключен - не зовётся; отказ вызова не по деньгам и не по остановке
 * (`passesThroughOptional`) - пропуск с пометкой, а не провал куска. Оплаченные ответы не по форме -
 * в пометке пропуска (В7). Включён ли этап, читается из настройки, а не из снимка запуска.
 */
export async function checkJev(
  llm: LlmService,
  operationId: string,
  translatedText: string,
  models: StageModels,
  ctx: LlmTaskContext,
): Promise<JevOutcome> {
  if (!(await llm.getStageSetting(CHECK_JEV_STAGE)).enabled) return { kind: 'disabled' };
  try {
    const answer = await callShaped(
      llm,
      operationId,
      CHECK_JEV_STAGE,
      jevRequest(translatedText),
      JEV_SHAPE,
      ctx,
      { remarks: CHECK_REMARKS, ...models },
    );
    if (!answer.ok) {
      return { kind: 'skipped', code: 'LLM_INVALID_RESPONSE', costUsd: answer.costUsd.toString() };
    }
    return {
      kind: 'answered',
      language: jevAnswerOf(answer.value),
      model: answer.model,
      costUsd: answer.costUsd.toString(),
    };
  } catch (error) {
    if (error instanceof LlmError && !passesThroughOptional(error.code)) {
      return { kind: 'skipped', code: error.code };
    }
    throw error;
  }
}
