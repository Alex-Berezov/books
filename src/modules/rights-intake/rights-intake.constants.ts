import { LATEST_RIGHTS_REPORT_SCHEMA_VERSION } from './rights-review-schema.registry';

/**
 * WP-M.1: 1.3 — в `source` появился `providerHint`, а задание агенту получило пункты,
 * зависящие от вида площадки. Версия поднята, потому что внешним агентам нужно перечитать
 * инструкции: контракт задания изменился.
 */
export const RIGHTS_AGENT_MANIFEST_VERSION = '1.3';

export const RIGHTS_AGENT_MANIFEST_TYPE = 'BIBLIARIS_RIGHTS_CLEARANCE_INPUT';

export const RIGHTS_AGENT_EXPECTED_REPORT_SCHEMA_VERSION = LATEST_RIGHTS_REPORT_SCHEMA_VERSION;

/** Public URL of the machine-readable report schema for the version above. */
export const RIGHTS_AGENT_REPORT_SCHEMA_URL = `https://api.bibliaris.com/api/rights/agent/report-schema/${LATEST_RIGHTS_REPORT_SCHEMA_VERSION}`;

/** Public endpoint the external agent posts its report to. */
export const RIGHTS_AGENT_SUBMISSION_ENDPOINT =
  'https://api.bibliaris.com/api/rights/agent/submissions';

/**
 * WP-10.3 (R4-04): статусные фильтры фаз 2 и 3 — белые списки, как в фазах 17–19
 * (`AGENT_TOKEN_ISSUABLE_INTAKE_STATUSES`, `LAWYER_ESCALATABLE_INTAKE_STATUSES`). Чёрные
 * списки, которые здесь стояли раньше, не знали о `LAWYER_REVIEW_REQUIRED` — статусе,
 * появившемся на 17 фаз позже, — и ошибались в опасную сторону: новое значение enum'а
 * автоматически становилось разрешённым. Белый список ошибается в безопасную.
 */

/** Intake statuses the agent manifest may be generated for (ТЗ фазы 2). */
export const MANIFEST_GENERATABLE_INTAKE_STATUSES: readonly string[] = ['READY_FOR_AGENT'];

/**
 * Intake statuses a review report may be imported for (ТЗ фазы 3 с осознанным расширением:
 * повторный импорт поверх уже материализованного, утверждённого или отклонённого интейка
 * разрешён, потому что это единственный способ принести более свежий отчёт).
 * `LAWYER_REVIEW_REQUIRED` в список не входит: пока юрист работает, вернуть интейк из этого
 * статуса вправе только фаза 19 — её условные апдейты ищут строку именно по нему.
 */
export const REVIEW_IMPORTABLE_INTAKE_STATUSES: readonly string[] = [
  'READY_FOR_AGENT',
  'REVIEW_IMPORTED',
  'HUMAN_REVIEW_REQUIRED',
  'APPROVED',
  'REJECTED',
];

/**
 * WP-10.3 (R3-06): статусы интейка, в которых редактор вправе утвердить проверку.
 * `REVIEW_IMPORTED` из списка убран: на момент утверждения он достижим ровно в одном
 * сценарии — поверх материализованного профиля загружен более свежий, ещё не
 * материализованный отчёт. Утверждение в этот момент закрепило бы в `approvedReviewId`
 * заведомо устаревший вердикт, и книга создалась бы из него. Из юридической проверки
 * интейк возвращается в `HUMAN_REVIEW_REQUIRED` (фаза 19), поэтому одного значения хватает.
 */
export const APPROVABLE_INTAKE_STATUSES: readonly string[] = ['HUMAN_REVIEW_REQUIRED'];
