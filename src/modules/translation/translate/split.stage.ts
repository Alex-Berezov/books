import { HttpException } from '@nestjs/common';
import { LlmError } from '../../llm/llm.errors';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskContext } from '../../llm-worker/llm-task.types';
import { ContestedWindow, fallbackBoundary } from '../chunking/chapter-chunks';
import { callShaped } from '../llm-shaped-call';
import { SPLIT_STAGE } from './translate.constants';
import { SPLIT_SHAPE } from './translate.format';
import { splitRequest } from './translate.prompts';

/**
 * Отказы, которые этап `split` не глушит запасной границей: бюджет ставит операцию на паузу,
 * остановка - не отказ, остальное (нет ключа) остановит и перевод. Прочее - модель не ответила
 * по делу: граница кодом (Р7, последний запасной).
 */
const PASS_THROUGH = new Set([
  'LLM_BUDGET_EXCEEDED',
  'LLM_INSUFFICIENT_FUNDS',
  'LLM_OPERATION_NOT_ACTIVE',
  'LLM_ABORTED',
]);

/**
 * Спорный стык главы: модель этапа `split` выбирает блок из окна, отказ - граница кодом.
 * `models` - модели снимка запуска (`F05-4`); без них - модели этапа.
 */
export async function pickBoundary(
  llm: LlmService,
  operationId: string,
  window: ContestedWindow,
  ctx: LlmTaskContext,
  models: { model?: string; fallbacks?: readonly string[] } = {},
): Promise<number> {
  const allowed = new Set(window.candidates.map((c) => c.block));
  try {
    const answer = await callShaped(
      llm,
      operationId,
      SPLIT_STAGE,
      splitRequest(window),
      SPLIT_SHAPE,
      ctx,
      {
        remarks: 1,
        model: models.model,
        fallbacks: models.fallbacks,
        extraErrors: (value) => {
          const block = (value as { boundaryBlock: number }).boundaryBlock;
          return allowed.has(block) ? [] : [`$.boundaryBlock: ${block} is not a candidate`];
        },
      },
    );
    if (answer.ok) return (answer.value as { boundaryBlock: number }).boundaryBlock;
  } catch (error) {
    if (error instanceof HttpException) throw error;
    if (!(error instanceof LlmError) || PASS_THROUGH.has(error.code)) throw error;
  }
  return fallbackBoundary(window);
}
