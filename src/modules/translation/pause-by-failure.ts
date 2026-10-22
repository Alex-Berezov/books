import { LlmPauseReason } from '@prisma/client';

/**
 * Отказ шага по деньгам - пауза операции своей причиной; код - как его пишет исполнитель
 * (`stepFailureCode`). Одна таблица на конвейер: досье, сравнение и запуск ставят одни и те же
 * причины на одни и те же отказы.
 */
export const BUDGET_PAUSE_BY_FAILURE: Readonly<Record<string, LlmPauseReason>> = {
  'LLM_BUDGET_EXCEEDED:operation': 'LIMIT_REACHED',
  'LLM_BUDGET_EXCEEDED:ceiling': 'CEILING_REACHED',
  LLM_INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
};

/**
 * Деньги и отказ всех провайдеров этапа (Р7): досье и запуск перевода. У сравнения отказ
 * провайдеров - отказ одной колонки, а не пауза (С9).
 */
export const PAUSE_BY_FAILURE: Readonly<Record<string, LlmPauseReason>> = {
  ...BUDGET_PAUSE_BY_FAILURE,
  LLM_NO_COMPLIANT_PROVIDER: 'NO_COMPLIANT_PROVIDER',
};
