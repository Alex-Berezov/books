import { Prisma } from '@prisma/client';
import { LlmError } from '../../llm/llm.errors';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskContext } from '../../llm-worker/llm-task.types';
import { Shape } from '../dossier/dossier.format';
import { ShapedRequest } from '../dossier/dossier.prompts';
import { callShaped } from '../llm-shaped-call';
import { StageModels } from '../run/run-models';
import { CHECK_REMARKS } from './check.constants';
import { independentModels } from './semantic-check';

/**
 * Итог вызова независимой проверки. `not_independent` - модели другого семейства нет, вызова не
 * было; `unavailable` - этап выключили или основная модель потеряла цену посреди запуска (решение
 * арбитра `F05 | F05-5`); `no_provider` - все модели отказали по политике данных, `models` - что
 * передано в вызов; `too_long` - вход не влезает в контекст моделей проверки, вызова нет;
 * `invalid` - ответ не по форме после повтора с замечанием, а после обрыва лимитом - без повтора
 * (`LEGACY-480`, решения арбитра `F05 | F05-13d`). Прочие отказы модуля LLM (деньги, остановка)
 * уходят вызывающему.
 */
export type IndependentOutcome<T> =
  | { kind: 'not_independent' }
  | { kind: 'unavailable'; code: string }
  | { kind: 'no_provider'; models: StageModels }
  | { kind: 'too_long' }
  | { kind: 'invalid'; costUsd: Prisma.Decimal }
  | { kind: 'answered'; answer: T; model: string; costUsd: Prisma.Decimal };

/** Отказы, при которых этапа для вызова нет: выключен или основная модель без цены. */
const UNAVAILABLE: readonly string[] = ['LLM_STAGE_DISABLED', 'LLM_NO_PRICE'];

/**
 * Вызов проверки моделью другого семейства (`tech.md` §3) - одно правило на сверку куска, стык
 * (`check_semantic`) и итоговую проверку (`final_check`, `F05-6`): модели этапа другого семейства,
 * чем модели, фактически переведшие текст; переход по 429 идёт только по ним. `translatedBy: null` -
 * модель перевода части текста неизвестна: независимость не установить, вызова нет.
 */
export async function callIndependent<T>(
  llm: LlmService,
  operationId: string,
  stage: string,
  request: ShapedRequest,
  shape: Shape,
  answerOf: (value: unknown) => T,
  translatedBy: string | readonly string[] | null,
  stageModels: StageModels,
  ctx: LlmTaskContext,
): Promise<IndependentOutcome<T>> {
  if (translatedBy === null) return { kind: 'not_independent' };
  const models = independentModels(await llm.stageCallModels(stage, stageModels), translatedBy);
  if (models.length === 0) return { kind: 'not_independent' };
  const chosen = { model: models[0], fallbacks: models.slice(1) };
  const fit = await llm.stageFit(stage, request, chosen.model, chosen.fallbacks);
  if (!fit.fits) return { kind: 'too_long' };
  try {
    const answer = await callShaped(llm, operationId, stage, request, shape, ctx, {
      remarks: CHECK_REMARKS,
      ...chosen,
    });
    if (!answer.ok) return { kind: 'invalid', costUsd: answer.costUsd };
    return {
      kind: 'answered',
      answer: answerOf(answer.value),
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

/**
 * Модели, переведшие куски с текстом: правило семейств сверяется по всем. Кусок с переводом без
 * записанной модели - `null`: независимость проверки не установить (флаг `*_NOT_INDEPENDENT`),
 * а не «никого исключать не надо». Кусок без переводимых блоков модели не звал - не в счёт.
 */
export function translatorsOf(
  chunks: ReadonlyArray<{ model: string | null; blocks: unknown }>,
): string[] | null {
  const translated = chunks.filter((c) => Array.isArray(c.blocks) && c.blocks.length > 0);
  if (translated.some((c) => c.model === null || c.model === '')) return null;
  return [...new Set(translated.map((c) => c.model as string))];
}
