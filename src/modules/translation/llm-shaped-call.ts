import { Prisma } from '@prisma/client';
import { LlmError, LlmTruncatedError } from '../llm/llm.errors';
import { LlmService } from '../llm/llm.service';
import { LlmChatResult } from '../llm/openrouter.client';
import { LlmTaskContext } from '../llm-worker/llm-task.types';
import { Shape, shapeErrors } from './dossier/dossier.format';
import { shapeRemark, ShapedRequest } from './dossier/dossier.prompts';

/**
 * `costUsd` - сумма факта всех ответов вызова, с повторами по замечанию (решение арбитра
 * `F05 | F05-4a`, В7); попытка, оборвавшаяся ошибкой без ответа, в неё не входит. Оплаченные
 * ответы, оборванные лимитом (`LlmTruncatedError`, `LEGACY-480`), входят.
 */
export type ShapedAnswer =
  | { ok: true; value: unknown; model: string; callId: string; costUsd: Prisma.Decimal }
  | { ok: false; costUsd: Prisma.Decimal };

export interface ShapedCallOptions {
  /** Повторов с замечанием после ответа не по форме: досье и глоссарий - 1, перевод - 2. */
  remarks: number;
  /** Проверка сверх формы (номера глав, номера блоков); ошибки уходят тем же замечанием. */
  extraErrors?: (value: unknown) => string[];
  /** Одна модель без запасных (сравнение `F05-3`) или с `fallbacks` (снимок запуска `F05-4`). */
  model?: string;
  fallbacks?: readonly string[];
}

/**
 * Вызов этапа с ответом по форме (`tech.md` §5): не по форме или не JSON - повтор с замечанием,
 * повторы кончились - `{ ok: false }`. После обрыва лимитом у этапа `truncationEndsModel` повтора
 * нет - `{ ok: false }` сразу: повтор начал бы цепочку с оборванной модели и оплатил бы её снова
 * (решения арбитра `F05 | F05-13d`). Прочие отказы модуля LLM уходят вызывающему: бюджет -
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
  let costUsd = new Prisma.Decimal(0);
  for (let attempt = 0; attempt <= options.remarks; attempt++) {
    let result: LlmChatResult;
    try {
      result = await llm.callStage(operationId, stage, conversation, {
        ...ctx.callOptions,
        jsonSchema,
        model: options.model,
        fallbacks: options.fallbacks,
      });
    } catch (error) {
      // Этап `truncationEndsModel`: оборвана последняя модель или после обрыва следующая ответила
      // не JSON (`LEGACY-480`) - повтор оплатил бы обрыв снова, отказ сразу, оплаченное в стоимости.
      if (error instanceof LlmTruncatedError)
        return { ok: false, costUsd: costUsd.add(error.costUsd) };
      if (!(error instanceof LlmError) || error.code !== 'LLM_INVALID_RESPONSE') throw error;
      if (attempt === options.remarks) return { ok: false, costUsd };
      conversation = [
        ...messages,
        { role: 'user', content: 'The answer was not valid JSON. Answer with JSON only.' },
      ];
      continue;
    }
    costUsd = costUsd.add(result.costUsd);
    const formErrors = shapeErrors(result.json, shape);
    const errors = formErrors.length > 0 ? formErrors : extraErrors(result.json);
    if (errors.length === 0) {
      return { ok: true, value: result.json, model: result.model, callId: result.callId, costUsd };
    }
    // После обрыва повтор с замечанием снова оплатил бы оборванную модель (решение `F05 | F05-13d`).
    if (attempt === options.remarks || result.afterTruncation) return { ok: false, costUsd };
    conversation = [
      ...messages,
      // Имена PREVIOUS_ANSWER и FORM_ERRORS свободны во всех сообщениях вызова; граница блока
      // исходного сообщения, повторённая в ответе, остаётся внутри ограды прошлого ответа -
      // вложение, не побег (решение арбитра `T146 | LEGACY-481`, круг 2).
      ...shapeRemark(
        result.content,
        errors,
        messages.map((m) => m.content),
      ),
    ];
  }
  return { ok: false, costUsd };
}
