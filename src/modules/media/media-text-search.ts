import { PrismaService } from '../../prisma/prisma.service';

/*
 * 🔴 Поиск ключа в текстах и Json — два статических запроса (решение арбитра T53, третья строка).
 *
 * Таблицы и колонки перечислены прямо в тексте SQL, а не подставлены из `media-text-columns.ts`
 * и `media-json-columns.ts`: `yarn drift-check` читает только такой SQL и сам сверяет каждую
 * колонку со схемой (LEGACY-123). Что литерал и таблицы совпадают в обе стороны, стережёт
 * `media-text-search.spec.ts`. Через параметр идут только ключи; `%`, `_` и обратная косая черта
 * в ключе экранируются в SQL — ключ ищется буквально. В память приходят ключи или
 * `Model.field`+id, но не тексты.
 */

/**
 * Какие из ключей встречаются хотя бы в одном тексте или Json. По проходу на таблицу для всей
 * пачки ключей (`JOIN … ON LIKE`), а не по проходу на каждый ключ.
 */
export async function findKeysInTexts(
  prisma: PrismaService,
  keys: readonly string[],
): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await prisma.$queryRaw<{ key: string }[]>`
    WITH k AS (
      SELECT u.key, '%' || replace(replace(replace(u.key, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%' AS pat
      FROM unnest(${[...keys]}::text[]) AS u(key)
    )
    SELECT k.key FROM k JOIN "BookVersion" t ON t."description"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "BookVersion" t ON t."shortDescription"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "BookVersion" t ON t."summaryShort"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "BookVersion" t ON t."rightsLicenseAttributionTextRu"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "BookSummary" t ON t."summary"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "BookSummary" t ON t."analysis"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "BookSummary" t ON t."themes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "Chapter" t ON t."content"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "AudioChapter" t ON t."description"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "AudioChapter" t ON t."transcript"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "Comment" t ON t."text"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "Page" t ON t."content"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "Page" t ON t."shortDescription"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "Seo" t ON t."metaDescription"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "Seo" t ON t."ogDescription"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "Seo" t ON t."eventDescription"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "AuthorTranslation" t ON t."biography"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "CategoryTranslation" t ON t."description"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "CategoryTranslation" t ON t."shortDescription"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "CategoryTranslation" t ON t."metaDescription"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "CategoryTranslation" t ON t."ogDescription"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "TagTranslation" t ON t."description"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "TagTranslation" t ON t."shortDescription"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "TagTranslation" t ON t."metaDescription"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "TagTranslation" t ON t."ogDescription"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "PersonTranslation" t ON t."biography"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "PersonTranslation" t ON t."shortDescription"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsLicense" t ON t."requiredAttributionText"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsClaim" t ON t."originalNoticeText"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsClaim" t ON t."claimedRightsDescriptionRu"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsClaim" t ON t."descriptionRu"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsClaim" t ON t."responseTextRu"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsClaim" t ON t."counterNoticeTextRu"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsClaimAttachment" t ON t."contentType"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsProfile" t ON t."summaryRu"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsReview" t ON t."summaryRu"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsEvidence" t ON t."summaryRu"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsAction" t ON t."descriptionRu"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsLegalChangeEvent" t ON t."descriptionRu"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsRecheckTask" t ON t."descriptionRu"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsLawyerReview" t ON t."contextRu"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsLawyerReview" t ON t."opinionSummaryRu"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsLegalOpinion" t ON t."bodyRu"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsLawyerReviewCondition" t ON t."textRu"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "BookVersion" t ON t."characters"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "BookVersion" t ON t."quotes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "BookVersion" t ON t."faq"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "BookVersion" t ON t."themes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "BookVersion" t ON t."alternativeTitles"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "BookVersion" t ON t."symbols"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "BookVersion" t ON t."rightsAllowedCountryCodes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "BookVersion" t ON t."rightsBlockedCountryCodes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "BookVersion" t ON t."rightsLicenseRequiredCountryCodes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "BookVersion" t ON t."rightsPendingCountryCodes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "BookVersion" t ON t."rightsRequiredActions"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "BookVersion" t ON t."rightsLicenseIds"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "BookVersion" t ON t."rightsLicenseUncoveredCountryCodes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "Page" t ON t."faq"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "Page" t ON t."sections"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "AuthorTranslation" t ON t."quotes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "AuthorTranslation" t ON t."faq"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "AuthorTranslation" t ON t."similarSlugs"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "CategoryTranslation" t ON t."faq"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "TagTranslation" t ON t."faq"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "TagTranslation" t ON t."relatedTagSlugs"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "TagTranslation" t ON t."relatedGenreSlugs"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "TagTranslation" t ON t."relatedCategorySlugs"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "TagTranslation" t ON t."relatedCollectionSlugs"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsIntake" t ON t."targetLanguages"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsIntake" t ON t."targetCountryCodes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsIntake" t ON t."plannedContentTypes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsIntake" t ON t."plannedComponents"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsReviewImport" t ON t."reportJson"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsReviewImport" t ON t."validationErrors"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsReviewImport" t ON t."validationWarnings"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsProfile" t ON t."riskFactors"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "ComponentTerritoryAssessment" t ON t."sourceEvidenceIds"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsAction" t ON t."affectedCountryCodes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "BookVersionContributor" t ON t."sourceEvidenceIds"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsProfileContributor" t ON t."sourceEvidenceIds"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsLicense" t ON t."countryCodes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsLicense" t ON t."excludedCountryCodes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsLicense" t ON t."languageCodes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsLicense" t ON t."mediaFormats"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsLicense" t ON t."sourceEvidenceIds"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsLicenseLink" t ON t."coversCountryCodes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsClaim" t ON t."affectedCountryCodes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsClaim" t ON t."affectedLanguages"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsClaim" t ON t."infringingUrls"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsAgentUploadToken" t ON t."allowedSchemaVersions"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsLegalChangeEvent" t ON t."jurisdictionCodes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsRecheckTask" t ON t."affectedCountryCodes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsLawyer" t ON t."jurisdictionCodes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsLawyerReview" t ON t."riskFactors"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsLawyerReview" t ON t."affectedCountryCodes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsLawyerReview" t ON t."affectedLanguages"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsLawyerReview" t ON t."affectedComponentIds"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsLawyerReview" t ON t."approvedCountryCodes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsLawyerReview" t ON t."blockedCountryCodes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsLegalOpinion" t ON t."jurisdictionCodes"::text LIKE k.pat ESCAPE '\\'
    UNION SELECT k.key FROM k JOIN "RightsLawyerReviewCondition" t ON t."affectedCountryCodes"::text LIKE k.pat ESCAPE '\\'`;
  return rows.map((row) => row.key);
}

/**
 * Где встречается ключ в любой из форм — для отказа 409: `Model.field (id)`, не больше `take`
 * на все колонки и формы.
 */
export async function findTextReferences(
  prisma: PrismaService,
  keys: readonly string[],
  take: number,
): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await prisma.$queryRaw<{ field: string; id: string }[]>`
    WITH k AS (
      SELECT '%' || replace(replace(replace(u.key, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%' AS pat
      FROM unnest(${[...keys]}::text[]) AS u(key)
    )
    SELECT m.field, m.id FROM (
      SELECT 'BookVersion.description' AS field, t.id::text AS id FROM "BookVersion" t, k WHERE t."description"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'BookVersion.shortDescription' AS field, t.id::text AS id FROM "BookVersion" t, k WHERE t."shortDescription"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'BookVersion.summaryShort' AS field, t.id::text AS id FROM "BookVersion" t, k WHERE t."summaryShort"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'BookVersion.rightsLicenseAttributionTextRu' AS field, t.id::text AS id FROM "BookVersion" t, k WHERE t."rightsLicenseAttributionTextRu"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'BookSummary.summary' AS field, t.id::text AS id FROM "BookSummary" t, k WHERE t."summary"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'BookSummary.analysis' AS field, t.id::text AS id FROM "BookSummary" t, k WHERE t."analysis"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'BookSummary.themes' AS field, t.id::text AS id FROM "BookSummary" t, k WHERE t."themes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'Chapter.content' AS field, t.id::text AS id FROM "Chapter" t, k WHERE t."content"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'AudioChapter.description' AS field, t.id::text AS id FROM "AudioChapter" t, k WHERE t."description"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'AudioChapter.transcript' AS field, t.id::text AS id FROM "AudioChapter" t, k WHERE t."transcript"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'Comment.text' AS field, t.id::text AS id FROM "Comment" t, k WHERE t."text"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'Page.content' AS field, t.id::text AS id FROM "Page" t, k WHERE t."content"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'Page.shortDescription' AS field, t.id::text AS id FROM "Page" t, k WHERE t."shortDescription"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'Seo.metaDescription' AS field, t.id::text AS id FROM "Seo" t, k WHERE t."metaDescription"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'Seo.ogDescription' AS field, t.id::text AS id FROM "Seo" t, k WHERE t."ogDescription"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'Seo.eventDescription' AS field, t.id::text AS id FROM "Seo" t, k WHERE t."eventDescription"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'AuthorTranslation.biography' AS field, t.id::text AS id FROM "AuthorTranslation" t, k WHERE t."biography"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'CategoryTranslation.description' AS field, t.id::text AS id FROM "CategoryTranslation" t, k WHERE t."description"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'CategoryTranslation.shortDescription' AS field, t.id::text AS id FROM "CategoryTranslation" t, k WHERE t."shortDescription"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'CategoryTranslation.metaDescription' AS field, t.id::text AS id FROM "CategoryTranslation" t, k WHERE t."metaDescription"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'CategoryTranslation.ogDescription' AS field, t.id::text AS id FROM "CategoryTranslation" t, k WHERE t."ogDescription"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'TagTranslation.description' AS field, t.id::text AS id FROM "TagTranslation" t, k WHERE t."description"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'TagTranslation.shortDescription' AS field, t.id::text AS id FROM "TagTranslation" t, k WHERE t."shortDescription"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'TagTranslation.metaDescription' AS field, t.id::text AS id FROM "TagTranslation" t, k WHERE t."metaDescription"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'TagTranslation.ogDescription' AS field, t.id::text AS id FROM "TagTranslation" t, k WHERE t."ogDescription"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'PersonTranslation.biography' AS field, t.id::text AS id FROM "PersonTranslation" t, k WHERE t."biography"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'PersonTranslation.shortDescription' AS field, t.id::text AS id FROM "PersonTranslation" t, k WHERE t."shortDescription"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsLicense.requiredAttributionText' AS field, t.id::text AS id FROM "RightsLicense" t, k WHERE t."requiredAttributionText"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsClaim.originalNoticeText' AS field, t.id::text AS id FROM "RightsClaim" t, k WHERE t."originalNoticeText"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsClaim.claimedRightsDescriptionRu' AS field, t.id::text AS id FROM "RightsClaim" t, k WHERE t."claimedRightsDescriptionRu"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsClaim.descriptionRu' AS field, t.id::text AS id FROM "RightsClaim" t, k WHERE t."descriptionRu"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsClaim.responseTextRu' AS field, t.id::text AS id FROM "RightsClaim" t, k WHERE t."responseTextRu"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsClaim.counterNoticeTextRu' AS field, t.id::text AS id FROM "RightsClaim" t, k WHERE t."counterNoticeTextRu"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsClaimAttachment.contentType' AS field, t.id::text AS id FROM "RightsClaimAttachment" t, k WHERE t."contentType"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsProfile.summaryRu' AS field, t.id::text AS id FROM "RightsProfile" t, k WHERE t."summaryRu"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsReview.summaryRu' AS field, t.id::text AS id FROM "RightsReview" t, k WHERE t."summaryRu"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsEvidence.summaryRu' AS field, t.id::text AS id FROM "RightsEvidence" t, k WHERE t."summaryRu"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsAction.descriptionRu' AS field, t.id::text AS id FROM "RightsAction" t, k WHERE t."descriptionRu"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsLegalChangeEvent.descriptionRu' AS field, t.id::text AS id FROM "RightsLegalChangeEvent" t, k WHERE t."descriptionRu"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsRecheckTask.descriptionRu' AS field, t.id::text AS id FROM "RightsRecheckTask" t, k WHERE t."descriptionRu"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsLawyerReview.contextRu' AS field, t.id::text AS id FROM "RightsLawyerReview" t, k WHERE t."contextRu"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsLawyerReview.opinionSummaryRu' AS field, t.id::text AS id FROM "RightsLawyerReview" t, k WHERE t."opinionSummaryRu"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsLegalOpinion.bodyRu' AS field, t.id::text AS id FROM "RightsLegalOpinion" t, k WHERE t."bodyRu"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsLawyerReviewCondition.textRu' AS field, t.id::text AS id FROM "RightsLawyerReviewCondition" t, k WHERE t."textRu"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'BookVersion.characters' AS field, t.id::text AS id FROM "BookVersion" t, k WHERE t."characters"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'BookVersion.quotes' AS field, t.id::text AS id FROM "BookVersion" t, k WHERE t."quotes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'BookVersion.faq' AS field, t.id::text AS id FROM "BookVersion" t, k WHERE t."faq"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'BookVersion.themes' AS field, t.id::text AS id FROM "BookVersion" t, k WHERE t."themes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'BookVersion.alternativeTitles' AS field, t.id::text AS id FROM "BookVersion" t, k WHERE t."alternativeTitles"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'BookVersion.symbols' AS field, t.id::text AS id FROM "BookVersion" t, k WHERE t."symbols"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'BookVersion.rightsAllowedCountryCodes' AS field, t.id::text AS id FROM "BookVersion" t, k WHERE t."rightsAllowedCountryCodes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'BookVersion.rightsBlockedCountryCodes' AS field, t.id::text AS id FROM "BookVersion" t, k WHERE t."rightsBlockedCountryCodes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'BookVersion.rightsLicenseRequiredCountryCodes' AS field, t.id::text AS id FROM "BookVersion" t, k WHERE t."rightsLicenseRequiredCountryCodes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'BookVersion.rightsPendingCountryCodes' AS field, t.id::text AS id FROM "BookVersion" t, k WHERE t."rightsPendingCountryCodes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'BookVersion.rightsRequiredActions' AS field, t.id::text AS id FROM "BookVersion" t, k WHERE t."rightsRequiredActions"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'BookVersion.rightsLicenseIds' AS field, t.id::text AS id FROM "BookVersion" t, k WHERE t."rightsLicenseIds"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'BookVersion.rightsLicenseUncoveredCountryCodes' AS field, t.id::text AS id FROM "BookVersion" t, k WHERE t."rightsLicenseUncoveredCountryCodes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'Page.faq' AS field, t.id::text AS id FROM "Page" t, k WHERE t."faq"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'Page.sections' AS field, t.id::text AS id FROM "Page" t, k WHERE t."sections"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'AuthorTranslation.quotes' AS field, t.id::text AS id FROM "AuthorTranslation" t, k WHERE t."quotes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'AuthorTranslation.faq' AS field, t.id::text AS id FROM "AuthorTranslation" t, k WHERE t."faq"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'AuthorTranslation.similarSlugs' AS field, t.id::text AS id FROM "AuthorTranslation" t, k WHERE t."similarSlugs"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'CategoryTranslation.faq' AS field, t.id::text AS id FROM "CategoryTranslation" t, k WHERE t."faq"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'TagTranslation.faq' AS field, t.id::text AS id FROM "TagTranslation" t, k WHERE t."faq"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'TagTranslation.relatedTagSlugs' AS field, t.id::text AS id FROM "TagTranslation" t, k WHERE t."relatedTagSlugs"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'TagTranslation.relatedGenreSlugs' AS field, t.id::text AS id FROM "TagTranslation" t, k WHERE t."relatedGenreSlugs"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'TagTranslation.relatedCategorySlugs' AS field, t.id::text AS id FROM "TagTranslation" t, k WHERE t."relatedCategorySlugs"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'TagTranslation.relatedCollectionSlugs' AS field, t.id::text AS id FROM "TagTranslation" t, k WHERE t."relatedCollectionSlugs"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsIntake.targetLanguages' AS field, t.id::text AS id FROM "RightsIntake" t, k WHERE t."targetLanguages"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsIntake.targetCountryCodes' AS field, t.id::text AS id FROM "RightsIntake" t, k WHERE t."targetCountryCodes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsIntake.plannedContentTypes' AS field, t.id::text AS id FROM "RightsIntake" t, k WHERE t."plannedContentTypes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsIntake.plannedComponents' AS field, t.id::text AS id FROM "RightsIntake" t, k WHERE t."plannedComponents"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsReviewImport.reportJson' AS field, t.id::text AS id FROM "RightsReviewImport" t, k WHERE t."reportJson"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsReviewImport.validationErrors' AS field, t.id::text AS id FROM "RightsReviewImport" t, k WHERE t."validationErrors"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsReviewImport.validationWarnings' AS field, t.id::text AS id FROM "RightsReviewImport" t, k WHERE t."validationWarnings"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsProfile.riskFactors' AS field, t.id::text AS id FROM "RightsProfile" t, k WHERE t."riskFactors"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'ComponentTerritoryAssessment.sourceEvidenceIds' AS field, t.id::text AS id FROM "ComponentTerritoryAssessment" t, k WHERE t."sourceEvidenceIds"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsAction.affectedCountryCodes' AS field, t.id::text AS id FROM "RightsAction" t, k WHERE t."affectedCountryCodes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'BookVersionContributor.sourceEvidenceIds' AS field, t.id::text AS id FROM "BookVersionContributor" t, k WHERE t."sourceEvidenceIds"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsProfileContributor.sourceEvidenceIds' AS field, t.id::text AS id FROM "RightsProfileContributor" t, k WHERE t."sourceEvidenceIds"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsLicense.countryCodes' AS field, t.id::text AS id FROM "RightsLicense" t, k WHERE t."countryCodes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsLicense.excludedCountryCodes' AS field, t.id::text AS id FROM "RightsLicense" t, k WHERE t."excludedCountryCodes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsLicense.languageCodes' AS field, t.id::text AS id FROM "RightsLicense" t, k WHERE t."languageCodes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsLicense.mediaFormats' AS field, t.id::text AS id FROM "RightsLicense" t, k WHERE t."mediaFormats"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsLicense.sourceEvidenceIds' AS field, t.id::text AS id FROM "RightsLicense" t, k WHERE t."sourceEvidenceIds"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsLicenseLink.coversCountryCodes' AS field, t.id::text AS id FROM "RightsLicenseLink" t, k WHERE t."coversCountryCodes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsClaim.affectedCountryCodes' AS field, t.id::text AS id FROM "RightsClaim" t, k WHERE t."affectedCountryCodes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsClaim.affectedLanguages' AS field, t.id::text AS id FROM "RightsClaim" t, k WHERE t."affectedLanguages"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsClaim.infringingUrls' AS field, t.id::text AS id FROM "RightsClaim" t, k WHERE t."infringingUrls"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsAgentUploadToken.allowedSchemaVersions' AS field, t.id::text AS id FROM "RightsAgentUploadToken" t, k WHERE t."allowedSchemaVersions"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsLegalChangeEvent.jurisdictionCodes' AS field, t.id::text AS id FROM "RightsLegalChangeEvent" t, k WHERE t."jurisdictionCodes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsRecheckTask.affectedCountryCodes' AS field, t.id::text AS id FROM "RightsRecheckTask" t, k WHERE t."affectedCountryCodes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsLawyer.jurisdictionCodes' AS field, t.id::text AS id FROM "RightsLawyer" t, k WHERE t."jurisdictionCodes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsLawyerReview.riskFactors' AS field, t.id::text AS id FROM "RightsLawyerReview" t, k WHERE t."riskFactors"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsLawyerReview.affectedCountryCodes' AS field, t.id::text AS id FROM "RightsLawyerReview" t, k WHERE t."affectedCountryCodes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsLawyerReview.affectedLanguages' AS field, t.id::text AS id FROM "RightsLawyerReview" t, k WHERE t."affectedLanguages"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsLawyerReview.affectedComponentIds' AS field, t.id::text AS id FROM "RightsLawyerReview" t, k WHERE t."affectedComponentIds"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsLawyerReview.approvedCountryCodes' AS field, t.id::text AS id FROM "RightsLawyerReview" t, k WHERE t."approvedCountryCodes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsLawyerReview.blockedCountryCodes' AS field, t.id::text AS id FROM "RightsLawyerReview" t, k WHERE t."blockedCountryCodes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsLegalOpinion.jurisdictionCodes' AS field, t.id::text AS id FROM "RightsLegalOpinion" t, k WHERE t."jurisdictionCodes"::text LIKE k.pat ESCAPE '\\'
      UNION ALL SELECT 'RightsLawyerReviewCondition.affectedCountryCodes' AS field, t.id::text AS id FROM "RightsLawyerReviewCondition" t, k WHERE t."affectedCountryCodes"::text LIKE k.pat ESCAPE '\\'
    ) AS m
    LIMIT ${take}`;
  return rows.map((row) => `${row.field} (${row.id})`);
}
