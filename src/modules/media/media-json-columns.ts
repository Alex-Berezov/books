import type { MediaSearchedColumn } from './media-text-columns';

/**
 * 🔴 Json-колонки критерия сироты (LEGACY-421, решение арбитра J1).
 *
 * Prisma не ищет подстроку в тексте Json, поэтому поиск идёт `$queryRaw` по `col::text`
 * (`media-text-search.ts`). Сюда входит каждая Json-колонка схемы, кроме исключений с причиной
 * в сторож-спеке `media-references.spec.ts`: ложное совпадение лишь оставляет файл, а пропуск
 * удаляет его необратимо. Эта таблица — источник для сторожей схемы, а SQL поиска пишет колонки
 * литералом: новая колонка добавляется в оба места, расхождение ловит `media-text-search.spec.ts`.
 */
export const MEDIA_JSON_COLUMNS: readonly MediaSearchedColumn[] = [
  ...[
    'characters',
    'quotes',
    'faq',
    'themes',
    'alternativeTitles',
    'symbols',
    'rightsAllowedCountryCodes',
    'rightsBlockedCountryCodes',
    'rightsLicenseRequiredCountryCodes',
    'rightsPendingCountryCodes',
    'rightsRequiredActions',
    'rightsLicenseIds',
    'rightsLicenseUncoveredCountryCodes',
  ].map((field) => ({ model: 'BookVersion', field })),
  { model: 'Page', field: 'faq' },
  { model: 'Page', field: 'sections' },
  ...['quotes', 'faq', 'similarSlugs'].map((field) => ({ model: 'AuthorTranslation', field })),
  { model: 'CategoryTranslation', field: 'faq' },
  ...[
    'faq',
    'relatedTagSlugs',
    'relatedGenreSlugs',
    'relatedCategorySlugs',
    'relatedCollectionSlugs',
  ].map((field) => ({ model: 'TagTranslation', field })),
  ...['targetLanguages', 'targetCountryCodes', 'plannedContentTypes', 'plannedComponents'].map(
    (field) => ({ model: 'RightsIntake', field }),
  ),
  ...['reportJson', 'validationErrors', 'validationWarnings'].map((field) => ({
    model: 'RightsReviewImport',
    field,
  })),
  { model: 'RightsProfile', field: 'riskFactors' },
  { model: 'ComponentTerritoryAssessment', field: 'sourceEvidenceIds' },
  { model: 'RightsAction', field: 'affectedCountryCodes' },
  { model: 'BookVersionContributor', field: 'sourceEvidenceIds' },
  { model: 'RightsProfileContributor', field: 'sourceEvidenceIds' },
  ...[
    'countryCodes',
    'excludedCountryCodes',
    'languageCodes',
    'mediaFormats',
    'sourceEvidenceIds',
  ].map((field) => ({ model: 'RightsLicense', field })),
  { model: 'RightsLicenseLink', field: 'coversCountryCodes' },
  ...['affectedCountryCodes', 'affectedLanguages', 'infringingUrls'].map((field) => ({
    model: 'RightsClaim',
    field,
  })),
  { model: 'RightsAgentUploadToken', field: 'allowedSchemaVersions' },
  { model: 'RightsLegalChangeEvent', field: 'jurisdictionCodes' },
  { model: 'RightsRecheckTask', field: 'affectedCountryCodes' },
  { model: 'RightsLawyer', field: 'jurisdictionCodes' },
  ...[
    'riskFactors',
    'affectedCountryCodes',
    'affectedLanguages',
    'affectedComponentIds',
    'approvedCountryCodes',
    'blockedCountryCodes',
  ].map((field) => ({ model: 'RightsLawyerReview', field })),
  { model: 'RightsLegalOpinion', field: 'jurisdictionCodes' },
  { model: 'RightsLawyerReviewCondition', field: 'affectedCountryCodes' },
];
