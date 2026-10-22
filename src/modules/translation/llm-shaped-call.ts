import { LlmError } from '../llm/llm.errors';
import { LlmService } from '../llm/llm.service';
import { LlmChatResult } from '../llm/openrouter.client';
import { LlmTaskContext } from '../llm-worker/llm-task.types';
import { Shape, shapeErrors } from './dossier/dossier.format';
import { shapeRemark, ShapedRequest } from './dossier/dossier.prompts';

export type ShapedAnswer =
  | { ok: true; value: unknown; model: string; callId: string }
  | { ok: false };

export interface ShapedCallOptions {
  /** Повторов с замечанием после ответа не по форме: досье и глоссарий - 1, перевод - 2. */
  remarks: number;
  /** Проверка сверх формы (номера глав, номера блоков); ошибки уходят тем же замечанием. */
  extraErrors?: (value: unknown) => string[];
  /** Одна модель без запасных (сравнение `F05-3`). */
  model?: string;
}

/**
 * Вызов этапа с ответом по форме (`tech.md` §5): не по форме или не JSON - повтор с замечанием,
 * повторы кончились - `{ ok: false }`. Прочие отказы модуля LLM уходят вызывающему: бюджет -
 * пауза, остальное решает обработчик. Каждая попытка - с опциями исполнителя (аренда, сигнал).
 */
export async function callShaped(
  llm: LlmService,
  operationId: string,
  stage: string,
  request: ShapedRequest,
  shape: Shape,
  ctx: LlmTaskContext,
  options: ShapedCallOptions,
): Promise<ShapedAnswer> {
  const { messages, jsonSchema } = request;
  const extraErrors = options.extraErrors ?? (() => []);
  let conversation = messages;
  for (let attempt = 0; attempt <= options.remarks; attempt++) {
    let result: LlmChatResult;
    try {
      result = await llm.callStage(operationId, stage, conversation, {
        ...ctx.callOptions,
        jsonSchema,
        model: options.model,
      });
    } catch (error) {
      if (!(error instanceof LlmError) || error.code !== 'LLM_INVALID_RESPONSE') throw error;
      if (attempt === options.remarks) return { ok: false };
      conversation = [
        ...messages,
        { role: 'user', content: 'The answer was not valid JSON. Answer with JSON only.' },
      ];
      continue;
    }
    const formErrors = shapeErrors(result.json, shape);
    const errors = formErrors.length > 0 ? formErrors : extraErrors(result.json);
    if (errors.length === 0) {
      return { ok: true, value: result.json, model: result.model, callId: result.callId };
    }
    if (attempt === options.remarks) return { ok: false };
    conversation = [...messages, ...shapeRemark(result.content, errors)];
  }
  return { ok: false };
}
