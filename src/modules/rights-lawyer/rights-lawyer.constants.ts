import {
  RightsLawyerConditionStatus,
  RightsLawyerDecision,
  RightsLawyerReviewStatus,
  RightsLawyerReviewTrigger,
  RightsLawyerType,
  RightsLegalOpinionKind,
  RightsRiskFactorCode,
  RightsRiskLevel,
} from './rights-lawyer-interface';

/**
 * This file must not import anything outside `./rights-lawyer-interface`: it is pulled in by
 * `RightsApprovalService` (module `rights-intake`), and any further import would risk a module
 * cycle. See ADR-003.
 */

export const LAWYER_REVIEW_DUE_DAYS_DEFAULT = 14;
export const LAWYER_OPINION_VALIDITY_DAYS_DEFAULT = 730; // 2 года
export const LAWYER_OPINION_EXPIRY_WARN_DAYS_DEFAULT = 60;
export const LAWYER_LIST_DEFAULT_LIMIT = 20;
export const LAWYER_LIST_MAX_LIMIT = 100;
export const LAWYER_EMBEDDED_ITEMS_LIMIT = 50;
export const LAWYER_OPINION_MAX_BODY_LENGTH = 200_000;
export const LAWYER_MIN_REASON_LENGTH = 10;
export const LAWYER_REVIEW_NUMBER_PREFIX = 'LR';
export const LAWYER_REVIEW_NUMBER_MAX_RETRIES = 5;

/** Environment variable names of Phase 19. All of them have defaults. */
export const LAWYER_ENV = {
  WORKFLOW_ENABLED: 'RIGHTS_LAWYER_WORKFLOW_ENABLED',
  BLOCK_APPROVAL_ON_HIGH_RISK: 'RIGHTS_LAWYER_BLOCK_APPROVAL_ON_HIGH_RISK',
  MIN_RISK_LEVEL: 'RIGHTS_LAWYER_MIN_RISK_LEVEL',
  REVIEW_DUE_DAYS: 'RIGHTS_LAWYER_REVIEW_DUE_DAYS',
  OPINION_VALIDITY_DAYS: 'RIGHTS_LAWYER_OPINION_VALIDITY_DAYS',
  OPINION_EXPIRY_WARN_DAYS: 'RIGHTS_LAWYER_OPINION_EXPIRY_WARN_DAYS',
} as const;

/** Risk levels in ascending order — the index is the rank used by every threshold check. */
export const RISK_LEVEL_ORDER: readonly RightsRiskLevel[] = [
  RightsRiskLevel.LOW,
  RightsRiskLevel.MEDIUM,
  RightsRiskLevel.HIGH,
  RightsRiskLevel.CRITICAL,
];

export const riskLevelRank = (level: RightsRiskLevel): number => {
  const index = RISK_LEVEL_ORDER.indexOf(level);
  return index === -1 ? 0 : index;
};

/** Statuses that count as an open (not yet decided) lawyer review. */
export const LAWYER_REVIEW_OPEN_STATUSES: readonly RightsLawyerReviewStatus[] = [
  RightsLawyerReviewStatus.PENDING,
  RightsLawyerReviewStatus.IN_PROGRESS,
];

/** Statuses that carry a positive opinion. */
export const LAWYER_REVIEW_POSITIVE_STATUSES: readonly RightsLawyerReviewStatus[] = [
  RightsLawyerReviewStatus.APPROVED,
  RightsLawyerReviewStatus.APPROVED_WITH_CONDITIONS,
];

/**
 * Status transition matrix. Same shape as `rights-claim.constants.ts`: any pair missing from
 * this table is rejected with `LAWYER_REVIEW_INVALID_TRANSITION` (409).
 * REJECTED / WITHDRAWN / EXPIRED are terminal — only an admin `reopen` moves them back.
 */
export const LAWYER_REVIEW_ALLOWED_TRANSITIONS: Record<
  RightsLawyerReviewStatus,
  RightsLawyerReviewStatus[]
> = {
  [RightsLawyerReviewStatus.PENDING]: [
    RightsLawyerReviewStatus.IN_PROGRESS,
    RightsLawyerReviewStatus.APPROVED,
    RightsLawyerReviewStatus.APPROVED_WITH_CONDITIONS,
    RightsLawyerReviewStatus.REJECTED,
    RightsLawyerReviewStatus.WITHDRAWN,
  ],
  [RightsLawyerReviewStatus.IN_PROGRESS]: [
    RightsLawyerReviewStatus.APPROVED,
    RightsLawyerReviewStatus.APPROVED_WITH_CONDITIONS,
    RightsLawyerReviewStatus.REJECTED,
    RightsLawyerReviewStatus.WITHDRAWN,
  ],
  [RightsLawyerReviewStatus.APPROVED]: [
    RightsLawyerReviewStatus.EXPIRED,
    RightsLawyerReviewStatus.WITHDRAWN,
  ],
  [RightsLawyerReviewStatus.APPROVED_WITH_CONDITIONS]: [
    RightsLawyerReviewStatus.EXPIRED,
    RightsLawyerReviewStatus.WITHDRAWN,
  ],
  [RightsLawyerReviewStatus.REJECTED]: [],
  [RightsLawyerReviewStatus.WITHDRAWN]: [],
  [RightsLawyerReviewStatus.EXPIRED]: [],
};

/** Statuses an admin `reopen` accepts. */
export const LAWYER_REVIEW_REOPENABLE_STATUSES: readonly RightsLawyerReviewStatus[] = [
  RightsLawyerReviewStatus.REJECTED,
  RightsLawyerReviewStatus.WITHDRAWN,
  RightsLawyerReviewStatus.EXPIRED,
];

/** Decision → status of the review that carries it. */
export const LAWYER_DECISION_TO_STATUS: Record<RightsLawyerDecision, RightsLawyerReviewStatus> = {
  [RightsLawyerDecision.APPROVED]: RightsLawyerReviewStatus.APPROVED,
  [RightsLawyerDecision.APPROVED_WITH_CONDITIONS]:
    RightsLawyerReviewStatus.APPROVED_WITH_CONDITIONS,
  [RightsLawyerDecision.REJECTED]: RightsLawyerReviewStatus.REJECTED,
};

/** Rights claim statuses that no longer contribute to risk. */
export const CLOSED_CLAIM_STATUSES: readonly string[] = ['RESOLVED', 'CLOSED', 'REJECTED'];

/** Rights action statuses that no longer contribute to risk. */
export const CLOSED_ACTION_STATUSES: readonly string[] = ['COMPLETED', 'WAIVED'];

/** Contributor roles whose unknown death year is a real copyright risk. */
export const RISKY_CONTRIBUTOR_ROLES: readonly string[] = [
  'TRANSLATOR',
  'ILLUSTRATOR',
  'EDITOR',
  'NARRATOR',
  'ADAPTER',
];

/**
 * WP-E.1: действия, которые агент назначает материалу, которого ещё нет — «проверить» и «ничего».
 * Вместе с пустым списком страновых оценок это признак «материала ещё нет», а не правовой
 * неопределённости: `KEEP`, `RETRANSLATE` и `OBTAIN_LICENSE` сюда не входят и по-прежнему
 * поднимают `UNCERTAIN_COMPONENT`.
 */
export const PLANNED_MATERIAL_REQUIRED_ACTIONS: readonly string[] = ['VERIFY', 'NONE'];

/**
 * WP-E.2: статусы страны, при которых осторожный `confidence: LOW` — действительно правовая
 * неопределённость, а не осторожность формулировки.
 */
export const CONTESTED_TERRITORY_STATUSES: readonly string[] = [
  'BLOCKED',
  'LICENSE_REQUIRED',
  'PENDING_REVIEW',
  'NOT_CHECKED',
];

/** Source text types that are derivative works and carry their own layer of rights. */
export const DERIVATIVE_SOURCE_TEXT_TYPES: readonly string[] = [
  'TRANSLATION',
  'ADAPTATION',
  'ABRIDGMENT',
  'COMPILATION',
];

/** Intake statuses that Phase 19 is allowed to move to LAWYER_REVIEW_REQUIRED. */
export const LAWYER_ESCALATABLE_INTAKE_STATUSES: readonly string[] = [
  'REVIEW_IMPORTED',
  'HUMAN_REVIEW_REQUIRED',
];

/** Profile statuses that Phase 19 is allowed to move to LAWYER_REVIEW_REQUIRED. */
export const LAWYER_ESCALATABLE_PROFILE_STATUSES: readonly string[] = [
  'IMPORTED',
  'HUMAN_REVIEW_REQUIRED',
];

// ---------------------------------------------------------------------------
// Risk factor catalogue
// ---------------------------------------------------------------------------

export const RISK_FACTOR_LEVELS: Record<RightsRiskFactorCode, RightsRiskLevel> = {
  [RightsRiskFactorCode.PUBLICATION_GATE_BLOCK]: RightsRiskLevel.CRITICAL,
  [RightsRiskFactorCode.OVERALL_STATUS_REJECTED]: RightsRiskLevel.CRITICAL,
  [RightsRiskFactorCode.CLAIM_ESCALATED_TO_LAWYER]: RightsRiskLevel.CRITICAL,
  [RightsRiskFactorCode.CRITICAL_CLAIM_OPEN]: RightsRiskLevel.CRITICAL,
  [RightsRiskFactorCode.AGENT_REQUESTED_LAWYER_REVIEW]: RightsRiskLevel.HIGH,
  // WP-E.2: базовый уровень понижен до MEDIUM. Сам по себе осторожный `confidence` юриста не
  // требует; `computeRiskAssessment` поднимает фактор обратно до HIGH, как только среди целевых
  // стран есть BLOCKED / LICENSE_REQUIRED / PENDING_REVIEW / NOT_CHECKED.
  [RightsRiskFactorCode.CONFIDENCE_LOW]: RightsRiskLevel.MEDIUM,
  [RightsRiskFactorCode.OVERALL_STATUS_INSUFFICIENT_DATA]: RightsRiskLevel.HIGH,
  [RightsRiskFactorCode.OVERALL_STATUS_LICENSE_REQUIRED]: RightsRiskLevel.HIGH,
  [RightsRiskFactorCode.UNCERTAIN_COMPONENT]: RightsRiskLevel.HIGH,
  [RightsRiskFactorCode.COPYRIGHTED_COMPONENT_KEPT]: RightsRiskLevel.HIGH,
  [RightsRiskFactorCode.LICENSE_REQUIRED_TERRITORY]: RightsRiskLevel.HIGH,
  [RightsRiskFactorCode.UNRESOLVED_BLOCKING_ACTION]: RightsRiskLevel.MEDIUM,
  [RightsRiskFactorCode.PENDING_REVIEW_TERRITORY]: RightsRiskLevel.MEDIUM,
  [RightsRiskFactorCode.CONFIDENCE_MEDIUM]: RightsRiskLevel.MEDIUM,
  [RightsRiskFactorCode.DERIVATIVE_SOURCE_TEXT]: RightsRiskLevel.MEDIUM,
  [RightsRiskFactorCode.CONTRIBUTOR_DEATH_YEAR_UNKNOWN]: RightsRiskLevel.MEDIUM,
  [RightsRiskFactorCode.BLOCKED_TERRITORY]: RightsRiskLevel.LOW,
};

export const RISK_FACTOR_MESSAGES_RU: Record<RightsRiskFactorCode, string> = {
  [RightsRiskFactorCode.PUBLICATION_GATE_BLOCK]: 'Публикационный шлюз профиля — BLOCK.',
  [RightsRiskFactorCode.OVERALL_STATUS_REJECTED]: 'Итоговый статус профиля прав — REJECTED.',
  [RightsRiskFactorCode.CLAIM_ESCALATED_TO_LAWYER]:
    'По книге есть претензия, эскалированная на юриста.',
  [RightsRiskFactorCode.CRITICAL_CLAIM_OPEN]:
    'Есть незакрытая критичная претензия правообладателя.',
  [RightsRiskFactorCode.AGENT_REQUESTED_LAWYER_REVIEW]:
    'Отчёт агента требует юридической проверки (действие LAWYER_REVIEW).',
  [RightsRiskFactorCode.CONFIDENCE_LOW]: 'Уверенность проверки прав — LOW.',
  [RightsRiskFactorCode.OVERALL_STATUS_INSUFFICIENT_DATA]:
    'Итоговый статус профиля — INSUFFICIENT_DATA: данных для решения не хватает.',
  [RightsRiskFactorCode.OVERALL_STATUS_LICENSE_REQUIRED]:
    'Итоговый статус профиля — LICENSE_REQUIRED: нужна лицензия.',
  [RightsRiskFactorCode.UNCERTAIN_COMPONENT]:
    'Есть компонент со статусом UNCERTAIN, который планируется сохранить.',
  [RightsRiskFactorCode.COPYRIGHTED_COMPONENT_KEPT]:
    'Есть защищённый авторским правом компонент с действием KEEP.',
  [RightsRiskFactorCode.LICENSE_REQUIRED_TERRITORY]: 'Есть страна со статусом LICENSE_REQUIRED.',
  [RightsRiskFactorCode.UNRESOLVED_BLOCKING_ACTION]:
    'Есть незакрытое блокирующее обязательное действие.',
  [RightsRiskFactorCode.PENDING_REVIEW_TERRITORY]:
    'Есть страна со статусом PENDING_REVIEW или NOT_CHECKED.',
  [RightsRiskFactorCode.CONFIDENCE_MEDIUM]: 'Уверенность проверки прав — MEDIUM.',
  [RightsRiskFactorCode.DERIVATIVE_SOURCE_TEXT]:
    'Исходный текст — производное произведение (перевод, адаптация, сокращение или сборник).',
  [RightsRiskFactorCode.CONTRIBUTOR_DEATH_YEAR_UNKNOWN]:
    'У участника с существенной ролью неизвестен год смерти — срок охраны не вычисляется.',
  [RightsRiskFactorCode.BLOCKED_TERRITORY]: 'Есть страна со статусом BLOCKED.',
};

export const RISK_LEVEL_LABELS_RU: Record<RightsRiskLevel, string> = {
  [RightsRiskLevel.LOW]: 'низкий',
  [RightsRiskLevel.MEDIUM]: 'средний',
  [RightsRiskLevel.HIGH]: 'высокий',
  [RightsRiskLevel.CRITICAL]: 'критический',
};

export const LAWYER_REVIEW_STATUS_LABELS_RU: Record<RightsLawyerReviewStatus, string> = {
  [RightsLawyerReviewStatus.PENDING]: 'ожидает юриста',
  [RightsLawyerReviewStatus.IN_PROGRESS]: 'в работе',
  [RightsLawyerReviewStatus.APPROVED]: 'согласовано',
  [RightsLawyerReviewStatus.APPROVED_WITH_CONDITIONS]: 'согласовано с условиями',
  [RightsLawyerReviewStatus.REJECTED]: 'отказано',
  [RightsLawyerReviewStatus.WITHDRAWN]: 'отозвано',
  [RightsLawyerReviewStatus.EXPIRED]: 'срок заключения истёк',
};

export const LAWYER_REVIEW_TRIGGER_LABELS_RU: Record<RightsLawyerReviewTrigger, string> = {
  [RightsLawyerReviewTrigger.AGENT_REQUESTED]: 'требование агента',
  [RightsLawyerReviewTrigger.HIGH_RISK_POLICY]: 'политика высокого риска',
  [RightsLawyerReviewTrigger.MANUAL_REQUEST]: 'ручной запрос редактора',
  [RightsLawyerReviewTrigger.RIGHTS_CLAIM]: 'претензия правообладателя',
  [RightsLawyerReviewTrigger.LEGAL_CHANGE]: 'изменение законодательства',
  [RightsLawyerReviewTrigger.LICENSE_REQUIRED]: 'требуется лицензия',
  [RightsLawyerReviewTrigger.OTHER]: 'другое',
};

export const LAWYER_TYPE_LABELS_RU: Record<RightsLawyerType, string> = {
  [RightsLawyerType.IN_HOUSE]: 'штатный юрист',
  [RightsLawyerType.EXTERNAL_COUNSEL]: 'внешний консультант',
  [RightsLawyerType.LAW_FIRM]: 'юридическая фирма',
  [RightsLawyerType.OTHER]: 'другое',
};

export const LEGAL_OPINION_KIND_LABELS_RU: Record<RightsLegalOpinionKind, string> = {
  [RightsLegalOpinionKind.EXTERNAL_COUNSEL_MEMO]: 'меморандум внешнего консультанта',
  [RightsLegalOpinionKind.IN_HOUSE_MEMO]: 'меморандум штатного юриста',
  [RightsLegalOpinionKind.EMAIL_CONFIRMATION]: 'подтверждение по электронной почте',
  [RightsLegalOpinionKind.COURT_FILING]: 'судебный документ',
  [RightsLegalOpinionKind.REGULATOR_RESPONSE]: 'ответ регулятора',
  [RightsLegalOpinionKind.OTHER]: 'другое',
};

export const LAWYER_CONDITION_STATUS_LABELS_RU: Record<RightsLawyerConditionStatus, string> = {
  [RightsLawyerConditionStatus.PENDING]: 'не выполнено',
  [RightsLawyerConditionStatus.SATISFIED]: 'выполнено',
  [RightsLawyerConditionStatus.WAIVED]: 'отменено',
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const LAWYER_ERROR_CODES = {
  LAWYER_NOT_FOUND: 'LAWYER_NOT_FOUND',
  LAWYER_INACTIVE: 'LAWYER_INACTIVE',
  LAWYER_USER_NOT_FOUND: 'LAWYER_USER_NOT_FOUND',
  LAWYER_USER_ALREADY_LINKED: 'LAWYER_USER_ALREADY_LINKED',
  LAWYER_INVALID_JURISDICTION: 'LAWYER_INVALID_JURISDICTION',
  LAWYER_REVIEW_NOT_FOUND: 'LAWYER_REVIEW_NOT_FOUND',
  LAWYER_REVIEW_INVALID_TRANSITION: 'LAWYER_REVIEW_INVALID_TRANSITION',
  LAWYER_REVIEW_ALREADY_CLOSED: 'LAWYER_REVIEW_ALREADY_CLOSED',
  LAWYER_TARGET_REQUIRED: 'LAWYER_TARGET_REQUIRED',
  LAWYER_PROFILE_NOT_FOUND: 'LAWYER_PROFILE_NOT_FOUND',
  LAWYER_INTAKE_NOT_FOUND: 'LAWYER_INTAKE_NOT_FOUND',
  LAWYER_VERSION_NOT_FOUND: 'LAWYER_VERSION_NOT_FOUND',
  LAWYER_SUBJECT_REVIEW_NOT_FOUND: 'LAWYER_SUBJECT_REVIEW_NOT_FOUND',
  LAWYER_SELF_ASSIGN_ONLY: 'LAWYER_SELF_ASSIGN_ONLY',
  LAWYER_DECISION_LAWYER_REQUIRED: 'LAWYER_DECISION_LAWYER_REQUIRED',
  LAWYER_CONDITIONS_REQUIRED: 'LAWYER_CONDITIONS_REQUIRED',
  LAWYER_CONDITION_NOT_FOUND: 'LAWYER_CONDITION_NOT_FOUND',
  LAWYER_CONDITION_ALREADY_CLOSED: 'LAWYER_CONDITION_ALREADY_CLOSED',
  LAWYER_OPINION_NOT_FOUND: 'LAWYER_OPINION_NOT_FOUND',
  LAWYER_OPINION_LAWYER_REQUIRED: 'LAWYER_OPINION_LAWYER_REQUIRED',
  LAWYER_OPINION_TOO_LARGE: 'LAWYER_OPINION_TOO_LARGE',
  LAWYER_OPINION_ALREADY_ARCHIVED: 'LAWYER_OPINION_ALREADY_ARCHIVED',
  LAWYER_INVALID_DUE_DATE: 'LAWYER_INVALID_DUE_DATE',
  LAWYER_INVALID_VALID_UNTIL: 'LAWYER_INVALID_VALID_UNTIL',
  LAWYER_REASON_TOO_SHORT: 'LAWYER_REASON_TOO_SHORT',
  LAWYER_WORKFLOW_DISABLED: 'LAWYER_WORKFLOW_DISABLED',
  LAWYER_REVIEW_NUMBER_GENERATION_FAILED: 'LAWYER_REVIEW_NUMBER_GENERATION_FAILED',
} as const;

export type LawyerErrorCode = (typeof LAWYER_ERROR_CODES)[keyof typeof LAWYER_ERROR_CODES];

export const LAWYER_ERROR_MESSAGES_EN: Record<LawyerErrorCode, string> = {
  LAWYER_NOT_FOUND: 'Lawyer not found.',
  LAWYER_INACTIVE: 'The lawyer is deactivated and cannot be assigned.',
  LAWYER_USER_NOT_FOUND: 'The user to link the lawyer to was not found.',
  LAWYER_USER_ALREADY_LINKED: 'This user is already linked to another lawyer.',
  LAWYER_INVALID_JURISDICTION: 'Invalid jurisdiction codes.',
  LAWYER_REVIEW_NOT_FOUND: 'Lawyer review not found.',
  LAWYER_REVIEW_INVALID_TRANSITION: 'This status transition is not allowed for the lawyer review.',
  LAWYER_REVIEW_ALREADY_CLOSED: 'The lawyer review is already closed.',
  LAWYER_TARGET_REQUIRED: 'At least one of rightsProfileId or rightsIntakeId is required.',
  LAWYER_PROFILE_NOT_FOUND: 'Rights profile not found.',
  LAWYER_INTAKE_NOT_FOUND: 'Rights intake not found.',
  LAWYER_VERSION_NOT_FOUND: 'Book version not found.',
  LAWYER_SUBJECT_REVIEW_NOT_FOUND: 'Rights review not found.',
  LAWYER_SELF_ASSIGN_ONLY: 'A lawyer may only assign a review to themselves.',
  LAWYER_DECISION_LAWYER_REQUIRED: 'A decision requires the lawyer it belongs to.',
  LAWYER_CONDITIONS_REQUIRED: 'An approval with conditions requires at least one condition.',
  LAWYER_CONDITION_NOT_FOUND: 'Condition not found.',
  LAWYER_CONDITION_ALREADY_CLOSED: 'The condition is already closed.',
  LAWYER_OPINION_NOT_FOUND: 'Legal opinion not found.',
  LAWYER_OPINION_LAWYER_REQUIRED: 'A legal opinion requires a lawyer.',
  LAWYER_OPINION_TOO_LARGE: 'The legal opinion body is too large.',
  LAWYER_OPINION_ALREADY_ARCHIVED: 'The legal opinion is already archived.',
  LAWYER_INVALID_DUE_DATE: 'Invalid due date.',
  LAWYER_INVALID_VALID_UNTIL: 'Invalid opinion validity date.',
  LAWYER_REASON_TOO_SHORT: 'The reason is too short.',
  LAWYER_WORKFLOW_DISABLED: 'The lawyer workflow is disabled.',
  LAWYER_REVIEW_NUMBER_GENERATION_FAILED: 'Could not generate a unique lawyer review number.',
};

export const LAWYER_ERROR_MESSAGES_RU: Record<LawyerErrorCode, string> = {
  LAWYER_NOT_FOUND: 'Юрист не найден.',
  LAWYER_INACTIVE: 'Юрист деактивирован — назначить его нельзя.',
  LAWYER_USER_NOT_FOUND: 'Пользователь для привязки юриста не найден.',
  LAWYER_USER_ALREADY_LINKED: 'Этот пользователь уже привязан к другому юристу.',
  LAWYER_INVALID_JURISDICTION: 'Некорректный список юрисдикций.',
  LAWYER_REVIEW_NOT_FOUND: 'Юридическая проверка не найдена.',
  LAWYER_REVIEW_INVALID_TRANSITION: 'Такой переход статуса юридической проверки недопустим.',
  LAWYER_REVIEW_ALREADY_CLOSED: 'Юридическая проверка уже закрыта.',
  LAWYER_TARGET_REQUIRED:
    'Нужно указать хотя бы одно из полей: rightsProfileId или rightsIntakeId.',
  LAWYER_PROFILE_NOT_FOUND: 'Профиль прав не найден.',
  LAWYER_INTAKE_NOT_FOUND: 'Интейк не найден.',
  LAWYER_VERSION_NOT_FOUND: 'Версия книги не найдена.',
  LAWYER_SUBJECT_REVIEW_NOT_FOUND: 'Проверка прав не найдена.',
  LAWYER_SELF_ASSIGN_ONLY: 'Юрист может назначить проверку только на себя.',
  LAWYER_DECISION_LAWYER_REQUIRED:
    'Для решения нужно указать юриста — иначе не сохранится его имя.',
  LAWYER_CONDITIONS_REQUIRED: 'Согласование с условиями требует хотя бы одного условия.',
  LAWYER_CONDITION_NOT_FOUND: 'Условие не найдено.',
  LAWYER_CONDITION_ALREADY_CLOSED: 'Условие уже закрыто.',
  LAWYER_OPINION_NOT_FOUND: 'Юридическое заключение не найдено.',
  LAWYER_OPINION_LAWYER_REQUIRED: 'Для заключения нужно указать юриста.',
  LAWYER_OPINION_TOO_LARGE: 'Текст юридического заключения слишком длинный.',
  LAWYER_OPINION_ALREADY_ARCHIVED: 'Юридическое заключение уже архивировано.',
  LAWYER_INVALID_DUE_DATE: 'Некорректный срок проверки.',
  LAWYER_INVALID_VALID_UNTIL: 'Некорректный срок действия заключения.',
  LAWYER_REASON_TOO_SHORT: 'Причина слишком короткая.',
  LAWYER_WORKFLOW_DISABLED: 'Юридический workflow выключен.',
  LAWYER_REVIEW_NUMBER_GENERATION_FAILED: 'Не удалось сгенерировать уникальный номер проверки.',
};

/**
 * Approval-side error code. Raised by `RightsApprovalService` (Phase 5) when a high-risk
 * clearance is approved without a valid lawyer opinion.
 */
export const LAWYER_APPROVAL_ERROR_CODES = {
  LAWYER_APPROVAL_REQUIRED: 'LAWYER_APPROVAL_REQUIRED',
} as const;

/** Publication gate reason codes contributed by Phase 19. Existing codes are untouched. */
export const LAWYER_GATE_CODES = {
  LAWYER_REVIEW_REQUIRED_NOT_APPROVED: 'LAWYER_REVIEW_REQUIRED_NOT_APPROVED',
  LAWYER_REVIEW_PENDING: 'LAWYER_REVIEW_PENDING',
  LAWYER_REVIEW_REJECTED: 'LAWYER_REVIEW_REJECTED',
  LAWYER_OPINION_EXPIRED: 'LAWYER_OPINION_EXPIRED',
  LAWYER_CONDITIONS_UNMET: 'LAWYER_CONDITIONS_UNMET',
  LAWYER_REVIEW_OPEN_NON_BLOCKING: 'LAWYER_REVIEW_OPEN_NON_BLOCKING',
  LAWYER_OPINION_EXPIRING_SOON: 'LAWYER_OPINION_EXPIRING_SOON',
  LAWYER_APPROVED_WITH_CONDITIONS: 'LAWYER_APPROVED_WITH_CONDITIONS',
  HIGH_RISK_WITHOUT_LAWYER_REVIEW: 'HIGH_RISK_WITHOUT_LAWYER_REVIEW',
  LAWYER_REVIEW_OVERDUE: 'LAWYER_REVIEW_OVERDUE',
} as const;
