/** Prefix of every agent upload token. */
export const AGENT_TOKEN_PREFIX = 'brat_';
/** Header the agent passes its token in. */
export const AGENT_TOKEN_HEADER = 'x-bibliaris-agent-token';
/** Entropy of a token, in bytes. */
export const AGENT_TOKEN_ENTROPY_BYTES = 32;
/** How many leading characters of the token the admin UI may display. */
export const AGENT_TOKEN_DISPLAY_PREFIX_LENGTH = 12;

export const AGENT_TOKEN_DEFAULT_TTL_HOURS = 72;
export const AGENT_TOKEN_MIN_TTL_HOURS = 1;
export const AGENT_TOKEN_MAX_TTL_HOURS = 720; // 30 days
export const AGENT_TOKEN_DEFAULT_MAX_USES = 1;
export const AGENT_TOKEN_MAX_MAX_USES = 10;
export const AGENT_TOKEN_DEFAULT_MAX_FAILED_ATTEMPTS = 5;
export const AGENT_TOKEN_MIN_REVOKE_REASON_LENGTH = 3;

/** Maximum size of an agent report body, in UTF-8 bytes. */
export const AGENT_REPORT_MAX_BYTES = 2_000_000;

/** Intake statuses in which an agent submission is accepted. */
export const AGENT_SUBMISSION_ALLOWED_INTAKE_STATUSES = [
  'READY_FOR_AGENT',
  'REVIEW_IMPORTED',
  'HUMAN_REVIEW_REQUIRED',
] as const;

/** Intake statuses in which an upload token may be issued. */
export const AGENT_TOKEN_ISSUABLE_INTAKE_STATUSES = ['READY_FOR_AGENT'] as const;

export const AGENT_ERROR_CODES = {
  AGENT_UPLOAD_DISABLED: 'AGENT_UPLOAD_DISABLED',
  AGENT_TOKEN_MISSING: 'AGENT_TOKEN_MISSING',
  AGENT_TOKEN_INVALID: 'AGENT_TOKEN_INVALID',
  AGENT_TOKEN_EXPIRED: 'AGENT_TOKEN_EXPIRED',
  AGENT_TOKEN_REVOKED: 'AGENT_TOKEN_REVOKED',
  AGENT_TOKEN_EXHAUSTED: 'AGENT_TOKEN_EXHAUSTED',
  AGENT_TOKEN_TOO_MANY_FAILURES: 'AGENT_TOKEN_TOO_MANY_FAILURES',
  AGENT_TOKEN_INTAKE_MISMATCH: 'AGENT_TOKEN_INTAKE_MISMATCH',
  AGENT_UPLOAD_RATE_LIMITED: 'AGENT_UPLOAD_RATE_LIMITED',
  INTAKE_NOT_FOUND: 'INTAKE_NOT_FOUND',
  INTAKE_NOT_ACCEPTING_SUBMISSIONS: 'INTAKE_NOT_ACCEPTING_SUBMISSIONS',
  INTAKE_NOT_ACCEPTING_TOKENS: 'INTAKE_NOT_ACCEPTING_TOKENS',
  REPORT_TOO_LARGE: 'REPORT_TOO_LARGE',
  UNSUPPORTED_SCHEMA_VERSION: 'UNSUPPORTED_SCHEMA_VERSION',
  DUPLICATE_SUBMISSION: 'DUPLICATE_SUBMISSION',
  INVALID_TOKEN_TTL: 'INVALID_TOKEN_TTL',
  INVALID_TOKEN_MAX_USES: 'INVALID_TOKEN_MAX_USES',
  AGENT_TOKEN_NOT_FOUND: 'AGENT_TOKEN_NOT_FOUND',
  AGENT_TOKEN_ALREADY_REVOKED: 'AGENT_TOKEN_ALREADY_REVOKED',
  AGENT_SUBMISSION_NOT_FOUND: 'AGENT_SUBMISSION_NOT_FOUND',
  NOTIFICATION_NOT_FOUND: 'NOTIFICATION_NOT_FOUND',
  /**
   * Отчёт принят и проверен, но разложить его по таблицам не удалось
   * (`LEGACY-197`). До 01.09.2026 это значение писалось в `rejectionCode`
   * строковым литералом мимо словаря, и парной фразы у него не было вовсе —
   * в `rejectionMessageRu` вместо неё оседал текст исключения Prisma.
   */
  IMPORT_FAILED: 'IMPORT_FAILED',
  /** Материализация отчёта в профиль прав отказала (`LEGACY-197`). */
  MATERIALIZATION_FAILED: 'MATERIALIZATION_FAILED',
} as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[keyof typeof AGENT_ERROR_CODES];

/** Russian messages returned alongside the machine-readable error codes. */
export const AGENT_ERROR_MESSAGES_RU: Record<AgentErrorCode, string> = {
  AGENT_UPLOAD_DISABLED: 'Приём отчётов от агента временно отключён.',
  AGENT_TOKEN_MISSING: 'Токен загрузки не передан.',
  AGENT_TOKEN_INVALID: 'Токен загрузки не найден.',
  AGENT_TOKEN_EXPIRED: 'Срок действия токена загрузки истёк.',
  AGENT_TOKEN_REVOKED: 'Токен загрузки отозван.',
  AGENT_TOKEN_EXHAUSTED: 'Токен загрузки уже использован.',
  AGENT_TOKEN_TOO_MANY_FAILURES: 'Превышено число неудачных попыток для этого токена.',
  AGENT_TOKEN_INTAKE_MISMATCH: 'Токен выпущен для другого интейка.',
  AGENT_UPLOAD_RATE_LIMITED: 'Слишком много запросов. Повторите попытку позже.',
  INTAKE_NOT_FOUND: 'Интейк не найден.',
  INTAKE_NOT_ACCEPTING_SUBMISSIONS: 'Текущий статус интейка не допускает приём отчёта.',
  INTAKE_NOT_ACCEPTING_TOKENS:
    'Токен можно выпустить только для интейка в статусе READY_FOR_AGENT.',
  REPORT_TOO_LARGE: 'Размер отчёта превышает допустимый предел.',
  UNSUPPORTED_SCHEMA_VERSION: 'Версия схемы отчёта не поддерживается.',
  DUPLICATE_SUBMISSION: 'Такой отчёт уже импортирован для этого интейка.',
  INVALID_TOKEN_TTL: 'Некорректный срок действия токена.',
  INVALID_TOKEN_MAX_USES: 'Некорректное число разрешённых использований токена.',
  AGENT_TOKEN_NOT_FOUND: 'Токен не найден.',
  AGENT_TOKEN_ALREADY_REVOKED: 'Токен уже отозван.',
  AGENT_SUBMISSION_NOT_FOUND: 'Отправка агента не найдена.',
  NOTIFICATION_NOT_FOUND: 'Уведомление не найдено.',
  IMPORT_FAILED:
    'Отчёт не удалось импортировать из-за внутренней ошибки. Подробности — в журнале сервера.',
  MATERIALIZATION_FAILED:
    'Отчёт импортирован, но профиль прав по нему не построен из-за внутренней ошибки. Подробности — в журнале сервера.',
};

/** English messages returned alongside the machine-readable error codes. */
export const AGENT_ERROR_MESSAGES_EN: Record<AgentErrorCode, string> = {
  AGENT_UPLOAD_DISABLED: 'Agent report upload is currently disabled.',
  AGENT_TOKEN_MISSING: 'Upload token is missing.',
  AGENT_TOKEN_INVALID: 'Upload token was not found.',
  AGENT_TOKEN_EXPIRED: 'Upload token has expired.',
  AGENT_TOKEN_REVOKED: 'Upload token has been revoked.',
  AGENT_TOKEN_EXHAUSTED: 'Upload token has already been used.',
  AGENT_TOKEN_TOO_MANY_FAILURES: 'Too many failed attempts for this upload token.',
  AGENT_TOKEN_INTAKE_MISMATCH: 'Upload token was issued for a different intake.',
  AGENT_UPLOAD_RATE_LIMITED: 'Too many requests. Please try again later.',
  INTAKE_NOT_FOUND: 'Rights intake was not found.',
  INTAKE_NOT_ACCEPTING_SUBMISSIONS: 'The intake status does not accept agent submissions.',
  INTAKE_NOT_ACCEPTING_TOKENS: 'An upload token can only be issued for a READY_FOR_AGENT intake.',
  REPORT_TOO_LARGE: 'The submitted report exceeds the maximum allowed size.',
  UNSUPPORTED_SCHEMA_VERSION: 'The report schema version is not supported.',
  DUPLICATE_SUBMISSION: 'An identical report has already been imported for this intake.',
  INVALID_TOKEN_TTL: 'Invalid token time-to-live.',
  INVALID_TOKEN_MAX_USES: 'Invalid maximum number of token uses.',
  AGENT_TOKEN_NOT_FOUND: 'Upload token was not found.',
  AGENT_TOKEN_ALREADY_REVOKED: 'Upload token is already revoked.',
  AGENT_SUBMISSION_NOT_FOUND: 'Agent submission was not found.',
  NOTIFICATION_NOT_FOUND: 'Notification was not found.',
  IMPORT_FAILED:
    'The report could not be imported because of an internal error. See the server log.',
  MATERIALIZATION_FAILED:
    'The report was imported, but the rights profile could not be built because of an internal error. See the server log.',
};
