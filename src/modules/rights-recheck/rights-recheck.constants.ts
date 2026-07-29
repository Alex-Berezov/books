import {
  RightsRecheckReason,
  RightsRecheckResolution,
  RightsRecheckStatus,
} from './rights-recheck-interface';

/** Reminder ladder: how many days before `dueAt` each reminder stage opens. Descending. */
export const RECHECK_REMINDER_LEAD_DAYS_DEFAULT = [30, 7] as const;
export const RECHECK_DEFAULT_INTERVAL_DAYS = 365;
export const RECHECK_MIN_INTERVAL_DAYS = 7;
export const RECHECK_MAX_INTERVAL_DAYS = 3650;
export const RECHECK_OVERDUE_GRACE_DAYS_DEFAULT = 30;
export const RECHECK_LEGAL_CHANGE_DUE_DAYS_DEFAULT = 14;
export const RECHECK_EVENT_DRIVEN_DUE_DAYS_DEFAULT = 7;
export const RECHECK_SCAN_BATCH_SIZE_DEFAULT = 500;
export const RECHECK_MAX_SNOOZE_DAYS = 180;

export const RECHECK_SCAN_INTERVAL_MS_DEFAULT = 21_600_000; // 6 hours
export const RECHECK_SCAN_INITIAL_DELAY_MS_DEFAULT = 60_000;

/** Maximum page size of every list endpoint of this module. */
export const RECHECK_LIST_MAX_LIMIT = 100;
export const RECHECK_LIST_DEFAULT_LIMIT = 20;

/** How many tasks a detail payload embeds (legal change details, version recheck, dashboard). */
export const RECHECK_EMBEDDED_TASKS_LIMIT = 50;

/** Task statuses that count as open. */
export const RECHECK_OPEN_STATUSES = [
  RightsRecheckStatus.PENDING,
  RightsRecheckStatus.IN_PROGRESS,
] as const;

/** Profile statuses for which a scheduled recheck makes sense. */
export const RECHECK_SCHEDULABLE_PROFILE_STATUSES = ['APPROVED'] as const;

/** Profile statuses a legal change may open tasks for. */
export const LEGAL_CHANGE_TARGET_PROFILE_STATUSES = ['APPROVED', 'HUMAN_REVIEW_REQUIRED'] as const;

/**
 * Reasons whose tasks are per-version rather than per-profile: two versions of the same
 * book may need independent rechecks, so `ensureTask` deduplicates them by `bookVersionId`.
 */
export const RECHECK_VERSION_SCOPED_REASONS = [
  RightsRecheckReason.CONTENT_CHANGED,
  RightsRecheckReason.AUDIO_ADDED,
  RightsRecheckReason.LANGUAGE_ADDED,
  RightsRecheckReason.COMPONENT_ADDED,
] as const;

/** Reasons whose tasks are closed automatically once the version is no longer stale. */
export const RECHECK_CONTENT_DRIVEN_REASONS = [
  RightsRecheckReason.CONTENT_CHANGED,
  RightsRecheckReason.AUDIO_ADDED,
  RightsRecheckReason.RIGHTS_DATA_CHANGED,
] as const;

/** Mapping of `BookVersion.rightsStaleReasonCode` (Phase 8) onto a recheck reason. */
export const STALE_REASON_TO_RECHECK_REASON: Record<string, RightsRecheckReason> = {
  CHAPTER_CREATED: RightsRecheckReason.CONTENT_CHANGED,
  CHAPTER_UPDATED: RightsRecheckReason.CONTENT_CHANGED,
  CHAPTER_DELETED: RightsRecheckReason.CONTENT_CHANGED,
  BOOK_VERSION_UPDATED: RightsRecheckReason.CONTENT_CHANGED,
  MANUAL_HASH_CHECK: RightsRecheckReason.CONTENT_CHANGED,
  SHARED_CLEARANCE_STALE: RightsRecheckReason.CONTENT_CHANGED,
  AUDIO_CHAPTER_CREATED: RightsRecheckReason.AUDIO_ADDED,
  AUDIO_CHAPTER_UPDATED: RightsRecheckReason.AUDIO_ADDED,
  AUDIO_CHAPTER_DELETED: RightsRecheckReason.AUDIO_ADDED,
  AUDIO_CHAPTER_REORDERED: RightsRecheckReason.AUDIO_ADDED,
  RIGHTS_SNAPSHOT_CHANGED: RightsRecheckReason.RIGHTS_DATA_CHANGED,
  SOURCE_EDITION_CHANGED: RightsRecheckReason.RIGHTS_DATA_CHANGED,
  REVIEW_IMPORT_CHANGED: RightsRecheckReason.RIGHTS_DATA_CHANGED,
};

/** Human-readable reason labels, shared by notification texts and the admin UI. */
export const RECHECK_REASON_LABELS_RU: Record<RightsRecheckReason, string> = {
  SCHEDULED_DUE: 'плановый срок перепроверки',
  CONTENT_CHANGED: 'изменился контент версии',
  RIGHTS_DATA_CHANGED: 'изменились данные о правах',
  LANGUAGE_ADDED: 'добавлена языковая версия',
  AUDIO_ADDED: 'добавлено или изменено аудио',
  COMPONENT_ADDED: 'добавлен компонент прав',
  LEGAL_CHANGE: 'изменение законодательства',
  REVIEW_STALE: 'проверка помечена как устаревшая',
  MANUAL_REQUEST: 'ручной запрос редактора',
  OTHER: 'другое',
};

export const RECHECK_RESOLUTION_LABELS_RU: Record<RightsRecheckResolution, string> = {
  NEW_REVIEW_APPROVED: 'утверждена новая проверка',
  SUPERSEDED_BY_NEW_REVIEW: 'закрыта более свежей утверждённой проверкой',
  NO_CHANGE_NEEDED: 'изменений не требуется',
  CONTENT_REVERTED: 'контент возвращён к состоянию clearance',
  MANUALLY_CLOSED: 'закрыта вручную',
  DISMISSED_NOT_APPLICABLE: 'отклонена как неприменимая',
  OTHER: 'другое',
};

export const RECHECK_ERROR_CODES = {
  RECHECK_TASK_NOT_FOUND: 'RECHECK_TASK_NOT_FOUND',
  RECHECK_TASK_ALREADY_CLOSED: 'RECHECK_TASK_ALREADY_CLOSED',
  RECHECK_TASK_INVALID_TRANSITION: 'RECHECK_TASK_INVALID_TRANSITION',
  RECHECK_TARGET_REQUIRED: 'RECHECK_TARGET_REQUIRED',
  RECHECK_INVALID_SNOOZE_DATE: 'RECHECK_INVALID_SNOOZE_DATE',
  RECHECK_INVALID_INTERVAL: 'RECHECK_INVALID_INTERVAL',
  RECHECK_PROFILE_NOT_FOUND: 'RECHECK_PROFILE_NOT_FOUND',
  RECHECK_VERSION_NOT_FOUND: 'RECHECK_VERSION_NOT_FOUND',
  RECHECK_INTAKE_NOT_FOUND: 'RECHECK_INTAKE_NOT_FOUND',
  RECHECK_REVIEW_NOT_FOUND: 'RECHECK_REVIEW_NOT_FOUND',
  RECHECK_SCAN_ALREADY_RUNNING: 'RECHECK_SCAN_ALREADY_RUNNING',
  LEGAL_CHANGE_NOT_FOUND: 'LEGAL_CHANGE_NOT_FOUND',
  LEGAL_CHANGE_NOT_EDITABLE: 'LEGAL_CHANGE_NOT_EDITABLE',
  LEGAL_CHANGE_ALREADY_APPLIED: 'LEGAL_CHANGE_ALREADY_APPLIED',
  LEGAL_CHANGE_INVALID_JURISDICTION: 'LEGAL_CHANGE_INVALID_JURISDICTION',
} as const;

export type RecheckErrorCode = (typeof RECHECK_ERROR_CODES)[keyof typeof RECHECK_ERROR_CODES];

export const RECHECK_ERROR_MESSAGES_EN: Record<RecheckErrorCode, string> = {
  RECHECK_TASK_NOT_FOUND: 'Recheck task not found.',
  RECHECK_TASK_ALREADY_CLOSED: 'The recheck task is already closed.',
  RECHECK_TASK_INVALID_TRANSITION: 'This status transition is not allowed for the recheck task.',
  RECHECK_TARGET_REQUIRED:
    'At least one of rightsProfileId, rightsIntakeId or bookVersionId is required.',
  RECHECK_INVALID_SNOOZE_DATE: 'Invalid snooze date.',
  RECHECK_INVALID_INTERVAL: 'Invalid recheck interval.',
  RECHECK_PROFILE_NOT_FOUND: 'Rights profile not found.',
  RECHECK_VERSION_NOT_FOUND: 'Book version not found.',
  RECHECK_INTAKE_NOT_FOUND: 'Rights intake not found.',
  RECHECK_REVIEW_NOT_FOUND: 'Rights review not found.',
  RECHECK_SCAN_ALREADY_RUNNING: 'A recheck scan is already running.',
  LEGAL_CHANGE_NOT_FOUND: 'Legal change event not found.',
  LEGAL_CHANGE_NOT_EDITABLE: 'Only a DRAFT legal change event can be edited.',
  LEGAL_CHANGE_ALREADY_APPLIED: 'The legal change event has already been applied.',
  LEGAL_CHANGE_INVALID_JURISDICTION: 'Invalid jurisdiction codes.',
};

export const RECHECK_ERROR_MESSAGES_RU: Record<RecheckErrorCode, string> = {
  RECHECK_TASK_NOT_FOUND: 'Задача перепроверки не найдена.',
  RECHECK_TASK_ALREADY_CLOSED: 'Задача перепроверки уже закрыта.',
  RECHECK_TASK_INVALID_TRANSITION: 'Такой переход статуса задачи перепроверки недопустим.',
  RECHECK_TARGET_REQUIRED:
    'Нужно указать хотя бы одно из полей: rightsProfileId, rightsIntakeId или bookVersionId.',
  RECHECK_INVALID_SNOOZE_DATE: 'Некорректная дата отложения задачи.',
  RECHECK_INVALID_INTERVAL: 'Некорректный интервал перепроверки.',
  RECHECK_PROFILE_NOT_FOUND: 'Профиль прав не найден.',
  RECHECK_VERSION_NOT_FOUND: 'Версия книги не найдена.',
  RECHECK_INTAKE_NOT_FOUND: 'Интейк не найден.',
  RECHECK_REVIEW_NOT_FOUND: 'Проверка прав не найдена.',
  RECHECK_SCAN_ALREADY_RUNNING: 'Скан перепроверок уже выполняется.',
  LEGAL_CHANGE_NOT_FOUND: 'Изменение законодательства не найдено.',
  LEGAL_CHANGE_NOT_EDITABLE: 'Редактировать можно только черновик изменения законодательства.',
  LEGAL_CHANGE_ALREADY_APPLIED: 'Изменение законодательства уже применено.',
  LEGAL_CHANGE_INVALID_JURISDICTION: 'Некорректный список юрисдикций.',
};

/** Publication gate reason codes contributed by Phase 18. Existing codes are untouched. */
export const RECHECK_GATE_CODES = {
  RIGHTS_RECHECK_OVERDUE: 'RIGHTS_RECHECK_OVERDUE',
  RIGHTS_RECHECK_LEGAL_CHANGE_PENDING: 'RIGHTS_RECHECK_LEGAL_CHANGE_PENDING',
  RIGHTS_RECHECK_DUE: 'RIGHTS_RECHECK_DUE',
  RIGHTS_RECHECK_TASK_OPEN: 'RIGHTS_RECHECK_TASK_OPEN',
  RIGHTS_RECHECK_TASK_SNOOZED: 'RIGHTS_RECHECK_TASK_SNOOZED',
  RIGHTS_RECHECK_DUE_SOON: 'RIGHTS_RECHECK_DUE_SOON',
} as const;
