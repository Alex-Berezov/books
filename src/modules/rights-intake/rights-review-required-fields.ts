/**
 * WP-6.2 — единственный источник правды о том, какие поля отчёта обязательны.
 *
 * До WP-6 один контракт описывали три расходящихся документа (R4-01): ТЗ фазы 3,
 * опубликованная JSON-схема 1.0 и рантайм-валидатор. Схема требовала больше, чем сервер,
 * сервер — меньше, чем БД, поэтому отчёт без обязательного поля проходил валидацию как
 * `VALIDATED` и ронял материализацию 500-й.
 *
 * За основу взяты колонки `NOT NULL` в `schema.prisma` — то, без чего запись физически
 * не создастся. Списки используют и `rights-review-schema-1.0.ts` (блоки `required`),
 * и `RightsReviewImportValidator` (проверки наличия), поэтому разойтись они больше не могут.
 */
export const REQUIRED_REPORT_FIELDS = {
  /**
   * Верхний уровень отчёта: `RightsProfile` / `RightsReview`. Совпадает с 14
   * `requiredTopLevelFields` манифеста фазы 2 — они и есть контракт с агентом.
   *
   * `nextReviewAt` в списке потому, что агент обязан ответить на вопрос о следующей
   * перепроверке; значение при этом nullable (колонка тоже), поэтому пустой ответ сервер
   * встречает предупреждением `MISSING_NEXT_REVIEW`, а не ошибкой.
   */
  root: [
    'schemaVersion',
    'intakeId',
    'overallStatus',
    'publicationGate',
    'summaryRu',
    'conclusionRu',
    'sourceAssessment',
    'languageAssessments',
    'componentAssessments',
    'territoryDecisions',
    'requiredActions',
    'evidence',
    'confidence',
    'nextReviewAt',
  ],
  /** `SourceEdition.status` (`schema.prisma`, модель `SourceEdition`). */
  sourceAssessment: ['status'],
  /**
   * `EditionRights` (WP-7.1): `languageCode` и `status` — `NOT NULL`, `translationOrigin` —
   * `NOT NULL` с дефолтом `UNKNOWN`, `requiresGeoBlock` — `NOT NULL` с дефолтом `false`.
   * Оба поля с дефолтом всё равно обязательны в отчёте: происхождение перевода и требование
   * геоблокировки — это вопросы манифеста фазы 2, на которые агент обязан ответить явно,
   * а молчаливый дефолт выглядел бы как ответ «оригинал, блокировка не нужна».
   */
  languageAssessments: ['languageCode', 'status', 'translationOrigin', 'requiresGeoBlock'],
  /** `RightsComponent`: `componentType`, `titleRu`, `status`, `requiredAction`, `confidence`. */
  componentAssessments: ['componentType', 'titleRu', 'status', 'requiredAction', 'confidence'],
  /**
   * `ComponentTerritoryAssessment`: `countryCode`, `status`, `accessPolicy` — `NOT NULL`,
   * `geoBlockRequired` — `NOT NULL` с дефолтом, но валидатор требует явного булева значения.
   */
  componentTerritoryAssessments: ['countryCode', 'status', 'accessPolicy', 'geoBlockRequired'],
  /** `TerritoryDecision`: `countryCode`, `finalStatus`, `accessPolicy`, `reasonRu`, `confidence`. */
  territoryDecisions: ['countryCode', 'finalStatus', 'accessPolicy', 'reasonRu', 'confidence'],
  /** `RightsAction`: `actionType` и `descriptionRu` — оба `NOT NULL`. */
  requiredActions: ['actionType', 'descriptionRu'],
  /** `RightsEvidence`: `evidenceType`, `sourceLevel`, `title`, `authority`, `summaryRu`. */
  evidence: ['evidenceType', 'sourceLevel', 'title', 'authority', 'summaryRu'],
  /** `RightsLicense`: блок необязателен целиком, но объявленная лицензия — с этими полями. */
  licenses: ['key', 'title', 'licensor'],
  /** `RightsProfileContributor` / `Person`: ключ нужен для ссылок `contributorRefs`. */
  contributors: ['key', 'role', 'displayName'],
} as const;

export type RequiredReportFieldBlock = keyof typeof REQUIRED_REPORT_FIELDS;
