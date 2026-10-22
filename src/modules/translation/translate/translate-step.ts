import { Prisma } from '@prisma/client';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskContext } from '../../llm-worker/llm-task.types';
import { ChapterLayout } from '../chapter-blocks';
import { callShaped } from '../llm-shaped-call';
import { TRANSLATE_REMARKS, TRANSLATE_STAGE } from './translate.constants';
import {
  blockText,
  cleanedBlockErrors,
  TranslatedBlock,
  TRANSLATE_SHAPE,
  translateBlockErrors,
} from './translate.format';
import { TranslateInput, translateRequest } from './translate.prompts';

/**
 * Итог перевода куска. `empty` - переводимых блоков нет (только `hr` и картинки без подписей),
 * модель не звалась; `too_long` - кусок с контекстом не влезает в контекст модели, вызова нет;
 * `invalid` - ответ не по форме после повторов с замечанием. Прочие отказы модуля LLM (бюджет,
 * провайдеры, остановка) уходят вызывающему: что с ними делать, решает его шаг. `costUsd` -
 * факт всех ответов, с повторами по замечанию.
 */
export type PieceTranslation =
  | {
      kind: 'translated';
      /** Только `n` и `text` блоков куска после белого списка разметки. */
      blocks: TranslatedBlock[];
      /** Ответ по форме как пришёл: находки глоссария запуск берёт из него. */
      raw: unknown;
      model: string;
      callId: string;
      costUsd: Prisma.Decimal;
    }
  | { kind: 'empty' }
  | { kind: 'too_long' }
  | { kind: 'invalid'; costUsd: Prisma.Decimal };

/**
 * Перевод одного куска (`F05-3`, шаг 2): общий для сравнения моделей и запуска перевода
 * (`F05-4`). Номера блоков проверяет код, разметка внутри блока - через белый список.
 * `models.model` без `fallbacks` - одна модель без запасных (сравнение, `stageModels` запуска),
 * с ними - модели снимка запуска; пусто - модели этапа.
 */
export async function translatePiece(
  llm: LlmService,
  operationId: string,
  input: TranslateInput,
  layout: Pick<ChapterLayout, 'blocks'>,
  ctx: LlmTaskContext,
  models: { model?: string; fallbacks?: readonly string[] } = {},
): Promise<PieceTranslation> {
  const expected = input.blocks.map((b) => b.n);
  if (expected.length === 0) return { kind: 'empty' };
  const request = translateRequest(input);
  const fit = await llm.stageFit(TRANSLATE_STAGE, request, models.model, models.fallbacks);
  if (!fit.fits) return { kind: 'too_long' };

  const kinds = new Map(layout.blocks.map((b) => [b.n, b]));
  const answer = await callShaped(
    llm,
    operationId,
    TRANSLATE_STAGE,
    request,
    TRANSLATE_SHAPE,
    ctx,
    {
      remarks: TRANSLATE_REMARKS,
      model: models.model,
      fallbacks: models.fallbacks,
      extraErrors: (value) => {
        const numbers = translateBlockErrors(value, expected);
        return numbers.length > 0 ? numbers : cleanedBlockErrors(value, kinds);
      },
    },
  );
  if (!answer.ok) return { kind: 'invalid', costUsd: answer.costUsd };

  const blocks = (answer.value as { blocks: TranslatedBlock[] }).blocks
    .filter((b) => expected.includes(b.n))
    .map((b) => ({
      n: b.n,
      text: blockText(kinds.get(b.n) ?? { kind: 'p' as const, html: '' }, b.text),
    }));
  return {
    kind: 'translated',
    blocks,
    raw: answer.value,
    model: answer.model,
    callId: answer.callId,
    costUsd: answer.costUsd,
  };
}
