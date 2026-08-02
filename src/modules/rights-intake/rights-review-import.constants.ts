import { LATEST_RIGHTS_REPORT_SCHEMA_VERSION } from './rights-review-schema.registry';

export const RIGHTS_REVIEW_IMPORT_SCHEMA_VERSION = LATEST_RIGHTS_REPORT_SCHEMA_VERSION;

/**
 * WP-G.4: синонимы, которые агент присылает вместо канонического значения `finalStatus`.
 * Нормализация обязана применяться и в валидаторе, и в материализации: иначе валидатор
 * пропустит `PUBLIC_DOMAIN`, а в Prisma-enum `TerritoryRightsStatus` уйдёт значение,
 * которого в нём нет, и импорт упадёт уже после `VALIDATED`.
 */
export const TERRITORY_FINAL_STATUS_SYNONYMS: Readonly<Record<string, string>> = {
  PUBLIC_DOMAIN: 'ALLOWED',
};

export const normalizeTerritoryFinalStatus = (value: string): string =>
  TERRITORY_FINAL_STATUS_SYNONYMS[value] ?? value;

/**
 * WP-G.2: `TerritoryDecision.reasonRu` — `NOT NULL`, а разрешающее решение больше не обязано
 * объяснять, почему разрешено. Дефолт заполняет колонку и одновременно честно сообщает,
 * что собственного обоснования у решения нет.
 */
export const TERRITORY_DECISION_DEFAULT_REASON_RU =
  'Агент не привёл обоснования: доступ разрешён без ограничений.';

/** WP-G.5: язык интейка, который агент не оценивал, материализуется этим статусом. */
export const UNASSESSED_LANGUAGE_STATUS = 'NOT_TARGETED';
