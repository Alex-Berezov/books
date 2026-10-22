import { BadRequestException } from '@nestjs/common';
import { LlmError } from '../llm/llm.errors';
import { LlmService, StageCallEstimator } from '../llm/llm.service';
import { llmTaskConflict } from '../llm-worker/llm-worker.errors';

/**
 * Проверки модели, выбранной редактором (сравнение `F05-3`, `stageModels` запуска `F05-4`): из
 * каталога OpenRouter, с ценой и на включённом этапе - иначе первый же шаг встал бы на паузу.
 */

/** Моделей нет в каталоге - 400 `LLM_MODEL_UNKNOWN` со списком. */
export async function assertKnownModels(llm: LlmService, models: readonly string[]): Promise<void> {
  const known = new Set((await llm.listModels()).map((m) => m.id));
  const unknown = models.filter((m) => !known.has(m));
  if (unknown.length > 0) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: `Unknown models: ${unknown.join(', ')}`,
      code: 'LLM_MODEL_UNKNOWN',
    });
  }
}

/**
 * Оценщик вызова этапа моделью для ручки: без цены - 409 `LLM_NO_PRICE`, выключенный этап -
 * 409 `LLM_STAGE_DISABLED`.
 */
export async function stageEstimatorFor(
  llm: LlmService,
  stage: string,
  model: string,
): Promise<StageCallEstimator> {
  let call: StageCallEstimator;
  try {
    call = await llm.stageCallEstimator(stage, model);
  } catch (error) {
    if (error instanceof LlmError) throw llmTaskConflict(error.code, error.message);
    throw error;
  }
  if (!call.enabled) {
    throw llmTaskConflict('LLM_STAGE_DISABLED', `LLM stage "${stage}" is disabled`);
  }
  return call;
}
