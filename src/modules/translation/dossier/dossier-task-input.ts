import { Language } from '@prisma/client';
import { EnqueueTaskInput } from '../../llm-worker/llm-task.service';
import { DOSSIER_TASK_KIND, GLOSSARY_TASK_KIND } from './dossier.constants';

/**
 * Задача досье. Ключ пары - «операция:строка»: «продолжить», пока прежний шаг ещё идёт,
 * находит его держателем и второй задачи не ставит (`LlmTaskService.resumeOperation`) - иначе
 * два шага строили бы одну строку и платили дважды.
 */
export function dossierTaskInput(
  dossierId: string,
  sourceVersionId: string,
  operationId: string,
): EnqueueTaskInput {
  return {
    kind: DOSSIER_TASK_KIND,
    operationId,
    bookVersionId: sourceVersionId,
    payload: { dossierId },
    pairKey: `${operationId}:${dossierId}`,
  };
}

/** Задача глоссария; ключ пары - как у досье. */
export function glossaryTaskInput(
  glossaryId: string,
  language: Language,
  sourceVersionId: string,
  operationId: string,
): EnqueueTaskInput {
  return {
    kind: GLOSSARY_TASK_KIND,
    operationId,
    bookVersionId: sourceVersionId,
    language,
    payload: { glossaryId },
    pairKey: `${operationId}:${glossaryId}`,
  };
}
