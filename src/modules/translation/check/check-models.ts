import { LlmService } from '../../llm/llm.service';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { StageModels } from '../run/run-models';
import { CHECK_SEMANTIC_STAGE } from './check.constants';
import { independentModels } from './semantic-check';

/**
 * Модели сверки смысла другого семейства, чем модель перевода запуска, - одно правило на оценку,
 * старт и «продолжить» (решения арбитра `F05 | F05-5`): модели - те же, что позовёт вызов
 * (`stageCallModels`: запасная без цены выпадает), иначе проверка видела бы модель, которой
 * у вызова нет. Нет ни одной - 409 `CHECK_MODEL_SAME_FAMILY`: такая настройка выключила бы сверку
 * на всю книгу при оплаченном переводе. Отбор на каждом вызове шага (`callIndependent`) остаётся.
 * Итоговая проверка (`final_check`, `F05-6`) - тем же правилом своим этапом (решение арбитра).
 */
export async function independentCheckModels(
  llm: LlmService,
  translateModel: string,
  models: StageModels = {},
  stage: string = CHECK_SEMANTIC_STAGE,
): Promise<string[]> {
  const checks = await llm.stageCallModels(stage, models);
  const independent = independentModels(checks, translateModel);
  if (independent.length === 0) {
    throw llmTaskConflict(
      'CHECK_MODEL_SAME_FAMILY',
      `Check models of ${stage} ${checks.join(', ')} are of the same family as the translate model "${translateModel}"`,
    );
  }
  return independent;
}
