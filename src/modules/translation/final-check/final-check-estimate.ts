import { Language, Prisma } from '@prisma/client';
import { LlmService, StageCallEstimator } from '../../llm/llm.service';
import { independentCheckModels } from '../check/check-models';
import { stageEstimatorFor } from '../llm-model-checks';
import { ChapterPlan } from '../translate/translate-estimate';
import { FINAL_CHECK_STAGE } from './final-check.constants';
import { finalCheckInputOf, finalCheckRequest } from './final-check.prompts';

/**
 * Итоговая проверка в оценке запуска (`F05-6`, 6c; поле `finalCheckUsd`): вызов на главу моделью,
 * которую возьмёт запуск, - первой другого семейства, чем модель перевода. Нет такой - 409
 * `CHECK_MODEL_SAME_FAMILY` (решение арбитра `F05 | F05-6`, В5: правило как у сверки смысла).
 */
export async function finalCheckEstimator(
  llm: LlmService,
  translateModel: string,
): Promise<StageCallEstimator> {
  const [model] = await independentCheckModels(llm, translateModel, {}, FINAL_CHECK_STAGE);
  return stageEstimatorFor(llm, FINAL_CHECK_STAGE, model);
}

/**
 * Итоговая проверка главы сверху: вход - тот же, что у шага (`finalCheckInputOf`, с именами
 * глоссария из читаемых блоков); перевода ещё нет - на его месте исходник тех же блоков (перевод
 * того же объёма). Досье и глоссарий не готовы - `extra` сверху, как у перевода и `metadata`.
 */
export function chapterFinalCheckUsd(
  check: StageCallEstimator,
  plan: ChapterPlan,
  languages: { sourceLanguage: Language; targetLanguage: Language },
  context: { glossary: unknown; dossier: unknown; extra: number },
): Prisma.Decimal {
  const translated = plan.layout.blocks
    .filter((b) => b.translatable)
    .map((b) => ({ n: b.n, text: b.html }));
  const input = finalCheckInputOf({
    layout: plan.layout,
    translated,
    ...languages,
    chapterNumber: plan.number,
    context,
  });
  if (input.blocks.length === 0) return new Prisma.Decimal(0);
  return check.estimate(finalCheckRequest(input), context.extra);
}
