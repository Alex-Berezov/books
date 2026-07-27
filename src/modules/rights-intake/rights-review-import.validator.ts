import { Injectable } from '@nestjs/common';

export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

type OverallStatus =
  | 'PUBLISHABLE'
  | 'PUBLISHABLE_AFTER_CHANGES'
  | 'PUBLISHABLE_WITH_GEO_RESTRICTIONS'
  | 'LICENSE_REQUIRED'
  | 'INSUFFICIENT_DATA'
  | 'REJECTED';
type PublicationGate = 'ALLOW' | 'ALLOW_AFTER_GEO_CONFIGURATION' | 'BLOCK';
type AccessPolicy = 'ALLOW' | 'BLOCK' | 'REVIEW_REQUIRED';
type LanguageCode = 'en' | 'es' | 'fr' | 'pt' | 'ru';

const VALID_OVERALL_STATUSES: OverallStatus[] = [
  'PUBLISHABLE',
  'PUBLISHABLE_AFTER_CHANGES',
  'PUBLISHABLE_WITH_GEO_RESTRICTIONS',
  'LICENSE_REQUIRED',
  'INSUFFICIENT_DATA',
  'REJECTED',
];
const VALID_PUBLICATION_GATES: PublicationGate[] = [
  'ALLOW',
  'ALLOW_AFTER_GEO_CONFIGURATION',
  'BLOCK',
];
const VALID_ACCESS_POLICIES: AccessPolicy[] = ['ALLOW', 'BLOCK', 'REVIEW_REQUIRED'];
const VALID_LANGUAGE_CODES: LanguageCode[] = ['en', 'es', 'fr', 'pt', 'ru'];
const VALID_CONFIDENCE = ['HIGH', 'MEDIUM', 'LOW'] as const;

const VALID_LANGUAGE_ASSESSMENT_STATUSES = [
  'ALLOWED',
  'ALLOWED_AFTER_CHANGES',
  'BLOCKED',
  'LICENSE_REQUIRED',
  'PENDING_REVIEW',
  'NOT_TARGETED',
] as const;
const VALID_TRANSLATION_ORIGINS = [
  'NOT_APPLICABLE_ORIGINAL',
  'GUTENBERG_TRANSLATION',
  'BIBLIARIS_TRANSLATION_FROM_ORIGINAL',
  'BIBLIARIS_TRANSLATION_FROM_INTERMEDIATE_TRANSLATION',
  'THIRD_PARTY_PUBLIC_DOMAIN_TRANSLATION',
  'THIRD_PARTY_LICENSED_TRANSLATION',
  'UNKNOWN',
] as const;
const VALID_COMPONENT_TYPES = [
  'ORIGINAL_TEXT',
  'TRANSLATION',
  'ADAPTATION',
  'ABRIDGMENT',
  'INTRODUCTION',
  'PREFACE',
  'AFTERWORD',
  'ANNOTATIONS',
  'FOOTNOTES',
  'BIOGRAPHY',
  'GLOSSARY',
  'INDEX',
  'EDITORIAL_REVISION',
  'COMPILATION_STRUCTURE',
  'ILLUSTRATION',
  'PHOTOGRAPH',
  'MAP',
  'COVER',
  'TYPOGRAPHIC_LAYOUT',
  'AUDIO_NARRATION',
  'AUDIO_RECORDING',
  'OTHER',
] as const;
const VALID_CONTRIBUTOR_ROLES = [
  'AUTHOR',
  'TRANSLATOR',
  'EDITOR',
  'ILLUSTRATOR',
  'NARRATOR',
  'ADAPTER',
  'COMPILER',
  'COMMENTATOR',
  'INTRODUCTION_AUTHOR',
  'AFTERWORD_AUTHOR',
  'COVER_ARTIST',
  'RIGHTS_HOLDER',
  'OTHER',
] as const;
const VALID_COMPONENT_STATUSES = [
  'PUBLIC_DOMAIN',
  'OWNED',
  'LICENSED',
  'PERMISSION_GRANTED',
  'COPYRIGHTED',
  'UNCERTAIN',
  'EXCLUDED',
] as const;
const VALID_COMPONENT_ACTIONS = [
  'KEEP',
  'REMOVE',
  'REPLACE',
  'RETRANSLATE',
  'OBTAIN_LICENSE',
  'VERIFY',
  'NONE',
] as const;
const VALID_TERRITORY_FINAL_STATUSES = [
  'ALLOWED',
  'ALLOWED_AFTER_CHANGES',
  'BLOCKED',
  'LICENSE_REQUIRED',
  'PENDING_REVIEW',
  'NOT_CHECKED',
  'NOT_TARGETED',
] as const;
const VALID_GEO_BLOCK_SCOPES = [
  'ENTIRE_BOOK',
  'LANGUAGE_EDITION',
  'TEXT_READER',
  'DOWNLOADS',
  'AUDIO',
  'SPECIFIC_ASSET',
] as const;
const VALID_ACTION_TYPES = [
  'REMOVE_COMPONENT',
  'REPLACE_COMPONENT',
  'CREATE_NEW_TRANSLATION',
  'TRANSLATE_FROM_ORIGINAL',
  'VERIFY_TRANSLATOR',
  'VERIFY_EDITION',
  'OBTAIN_LICENSE',
  'CONFIGURE_GEO_BLOCK',
  'VERIFY_GEO_BLOCK',
  'REMOVE_GUTENBERG_HEADER',
  'REMOVE_GUTENBERG_FOOTER',
  'REMOVE_GUTENBERG_LICENSE',
  'REPLACE_COVER',
  'REPLACE_ILLUSTRATIONS',
  'RECHECK_LATER',
  'LAWYER_REVIEW',
  'OTHER',
] as const;
const VALID_EVIDENCE_TYPES = [
  'GUTENBERG_PAGE',
  'GUTENBERG_FILE_NOTICE',
  'OFFICIAL_LAW',
  'COURT_DECISION',
  'COPYRIGHT_REGISTRY',
  'RENEWAL_RECORD',
  'LIBRARY_CATALOG',
  'AUTHORITY_RECORD',
  'LICENSE_DOCUMENT',
  'PERMISSION_LETTER',
  'CONTRACT',
  'SCREENSHOT',
  'FILE_EXCERPT',
  'LEGAL_OPINION',
  'SECONDARY_GUIDANCE',
  'OTHER',
] as const;
const VALID_EVIDENCE_SOURCE_LEVELS = ['PRIMARY', 'OFFICIAL_BIBLIOGRAPHIC', 'SECONDARY'] as const;
const VALID_SOURCE_PROVIDERS = ['PROJECT_GUTENBERG', 'OTHER', 'UNKNOWN'] as const;
const VALID_GUTENBERG_STATUSES = [
  'PUBLIC_DOMAIN_US',
  'POSTED_WITH_PERMISSION',
  'UNCERTAIN',
] as const;
const VALID_SOURCE_STATUSES = [
  'ALLOWED',
  'LICENSE_REQUIRED',
  'COPYRIGHTED',
  'UNCERTAIN',
  'INSUFFICIENT_DATA',
] as const;
const VALID_SOURCE_TEXT_TYPES = [
  'ORIGINAL_TEXT',
  'TRANSLATION',
  'ADAPTATION',
  'ABRIDGMENT',
  'COMPILATION',
  'UNKNOWN',
] as const;

function isIn<T extends readonly string[]>(arr: T, value: string): value is T[number] {
  return (arr as readonly string[]).includes(value);
}

function addError(errors: ValidationIssue[], path: string, message: string, code: string) {
  errors.push({ path, message, code });
}

function addWarning(warnings: ValidationIssue[], path: string, message: string, code: string) {
  warnings.push({ path, message, code });
}

@Injectable()
export class RightsReviewImportValidator {
  validate(
    reportJson: Record<string, unknown>,
    intakeId: string,
    targetLanguages: string[],
    targetCountryCodes: string[],
  ): { errors: ValidationIssue[]; warnings: ValidationIssue[] } {
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    const schemaVersion = reportJson['schemaVersion'] as string | undefined;
    if (!schemaVersion) {
      addError(errors, 'schemaVersion', 'schemaVersion is required', 'MISSING_FIELD');
    } else if (schemaVersion !== '1.0') {
      addError(
        errors,
        'schemaVersion',
        `schemaVersion must be "1.0", got "${schemaVersion}"`,
        'INVALID_SCHEMA_VERSION',
      );
    }

    const reportIntakeId = reportJson['intakeId'] as string | undefined;
    if (!reportIntakeId) {
      addError(errors, 'intakeId', 'intakeId is required', 'MISSING_FIELD');
    } else if (reportIntakeId !== intakeId) {
      addError(
        errors,
        'intakeId',
        `intakeId mismatch: expected "${intakeId}", got "${reportIntakeId}"`,
        'INTAKE_ID_MISMATCH',
      );
    }

    const overallStatus = reportJson['overallStatus'] as string | undefined;
    if (!overallStatus) {
      addError(errors, 'overallStatus', 'overallStatus is required', 'MISSING_FIELD');
    } else if (!isIn(VALID_OVERALL_STATUSES, overallStatus)) {
      addError(
        errors,
        'overallStatus',
        `Invalid overallStatus: "${overallStatus}"`,
        'INVALID_ENUM',
      );
    }

    const publicationGate = reportJson['publicationGate'] as string | undefined;
    if (!publicationGate) {
      addError(errors, 'publicationGate', 'publicationGate is required', 'MISSING_FIELD');
    } else if (!isIn(VALID_PUBLICATION_GATES, publicationGate)) {
      addError(
        errors,
        'publicationGate',
        `Invalid publicationGate: "${publicationGate}"`,
        'INVALID_ENUM',
      );
    }

    if (publicationGate && overallStatus) {
      if (overallStatus === 'REJECTED' && publicationGate !== 'BLOCK') {
        addError(
          errors,
          'overallStatus',
          'overallStatus=REJECTED requires publicationGate=BLOCK',
          'REJECTED_NOT_BLOCKED',
        );
      }
      if (overallStatus === 'LICENSE_REQUIRED' && publicationGate === 'ALLOW') {
        addError(
          errors,
          'overallStatus',
          'overallStatus=LICENSE_REQUIRED conflicts with publicationGate=ALLOW',
          'LICENSE_REQUIRED_ALLOW_CONFLICT',
        );
      }
    }

    if (!reportJson['summaryRu']) {
      addError(errors, 'summaryRu', 'summaryRu is required', 'MISSING_FIELD');
    }

    // Validate contributors array
    const contributors = reportJson['contributors'];
    const validContributorKeys = new Set<string>();
    const contributorRolesMap = new Map<string, string[]>();

    if (contributors !== undefined && contributors !== null) {
      if (!Array.isArray(contributors)) {
        addError(errors, 'contributors', 'contributors must be an array', 'INVALID_TYPE');
      } else {
        for (let i = 0; i < contributors.length; i++) {
          const item = contributors[i] as Record<string, unknown>;
          const prefix = `contributors[${i}]`;

          const key = item['key'] as string | undefined;
          if (!key || typeof key !== 'string') {
            addError(
              errors,
              `${prefix}.key`,
              'key is required and must be a string',
              'MISSING_FIELD',
            );
          } else {
            validContributorKeys.add(key);
          }

          const role = item['role'] as string | undefined;
          if (!role || typeof role !== 'string') {
            addError(errors, `${prefix}.role`, 'role is required', 'MISSING_FIELD');
          } else if (!isIn(VALID_CONTRIBUTOR_ROLES, role)) {
            addError(
              errors,
              `${prefix}.role`,
              `Invalid contributor role: "${role}"`,
              'INVALID_ENUM',
            );
          } else {
            if (key) {
              const roles = contributorRolesMap.get(key) || [];
              roles.push(role);
              contributorRolesMap.set(key, roles);
            }
          }

          if (role === 'OTHER') {
            const roleOtherRu = item['roleOtherRu'] as string | undefined;
            if (!roleOtherRu || typeof roleOtherRu !== 'string') {
              addError(
                errors,
                `${prefix}.roleOtherRu`,
                'roleOtherRu is required when role is OTHER',
                'MISSING_FIELD',
              );
            }
          }

          if (role === 'TRANSLATOR') {
            const creditedLang =
              (item['creditedLanguage'] as string) || (item['targetLanguage'] as string);
            if (!creditedLang || typeof creditedLang !== 'string') {
              addWarning(
                warnings,
                `${prefix}.creditedLanguage`,
                'TRANSLATOR contributor should specify creditedLanguage or targetLanguage to ensure precise language version projection',
                'MISSING_TRANSLATOR_LANGUAGE',
              );
            }
          }

          const displayName = item['displayName'] as string | undefined;
          if (!displayName || typeof displayName !== 'string') {
            addError(errors, `${prefix}.displayName`, 'displayName is required', 'MISSING_FIELD');
          }

          const birthYear = item['birthYear'] as number | undefined;
          const deathYear = item['deathYear'] as number | undefined;
          if (birthYear !== undefined && (!Number.isInteger(birthYear) || birthYear < 0)) {
            addError(
              errors,
              `${prefix}.birthYear`,
              'birthYear must be a positive integer',
              'INVALID_TYPE',
            );
          }
          if (deathYear !== undefined && (!Number.isInteger(deathYear) || deathYear < 0)) {
            addError(
              errors,
              `${prefix}.deathYear`,
              'deathYear must be a positive integer',
              'INVALID_TYPE',
            );
          }
          if (
            birthYear !== undefined &&
            deathYear !== undefined &&
            Number.isInteger(birthYear) &&
            Number.isInteger(deathYear) &&
            deathYear < birthYear
          ) {
            addError(
              errors,
              `${prefix}.deathYear`,
              `deathYear (${deathYear}) cannot be less than birthYear (${birthYear})`,
              'INVALID_VALUE',
            );
          }

          const publicDomainFromYear = item['publicDomainFromYear'] as number | undefined;
          if (
            publicDomainFromYear !== undefined &&
            (!Number.isInteger(publicDomainFromYear) || publicDomainFromYear < 0)
          ) {
            addError(
              errors,
              `${prefix}.publicDomainFromYear`,
              'publicDomainFromYear must be a positive integer',
              'INVALID_TYPE',
            );
          }

          const sourceEvidenceIds = item['sourceEvidenceIds'];
          if (sourceEvidenceIds !== undefined && !Array.isArray(sourceEvidenceIds)) {
            addError(
              errors,
              `${prefix}.sourceEvidenceIds`,
              'sourceEvidenceIds must be an array of strings',
              'INVALID_TYPE',
            );
          }
        }
      }
    }

    const candidateAuthor = reportJson['candidateAuthor'] as string | undefined;
    const hasAuthorContributor = Array.from(contributorRolesMap.values()).some((roles) =>
      roles.includes('AUTHOR'),
    );
    if (
      candidateAuthor &&
      !hasAuthorContributor &&
      Array.isArray(contributors) &&
      contributors.length > 0
    ) {
      addWarning(
        warnings,
        'contributors',
        `candidateAuthor "${candidateAuthor}" is specified, but no contributor with role AUTHOR is present in top-level contributors`,
        'MISSING_AUTHOR_WARNING',
      );
    }
    if (!reportJson['conclusionRu']) {
      addError(errors, 'conclusionRu', 'conclusionRu is required', 'MISSING_FIELD');
    }

    const sourceAssessment = reportJson['sourceAssessment'] as Record<string, unknown> | undefined;
    if (!sourceAssessment) {
      addError(errors, 'sourceAssessment', 'sourceAssessment is required', 'MISSING_FIELD');
    }

    const languageAssessments = reportJson['languageAssessments'];
    if (!Array.isArray(languageAssessments)) {
      addError(errors, 'languageAssessments', 'languageAssessments must be an array', 'NOT_ARRAY');
    }

    const componentAssessments = reportJson['componentAssessments'];
    if (!Array.isArray(componentAssessments)) {
      addError(
        errors,
        'componentAssessments',
        'componentAssessments must be an array',
        'NOT_ARRAY',
      );
    } else if (componentAssessments.length === 0) {
      addWarning(warnings, 'componentAssessments', 'componentAssessments is empty', 'EMPTY_ARRAY');
    }

    const territoryDecisions = reportJson['territoryDecisions'];
    if (!Array.isArray(territoryDecisions)) {
      addError(errors, 'territoryDecisions', 'territoryDecisions must be an array', 'NOT_ARRAY');
    }

    const requiredActions = reportJson['requiredActions'];
    if (!Array.isArray(requiredActions)) {
      addError(errors, 'requiredActions', 'requiredActions must be an array', 'NOT_ARRAY');
    }

    const evidence = reportJson['evidence'];
    if (!Array.isArray(evidence)) {
      addError(errors, 'evidence', 'evidence must be an array', 'NOT_ARRAY');
    } else if (evidence.length === 0) {
      addWarning(warnings, 'evidence', 'evidence is empty', 'EMPTY_ARRAY');
    }

    const confidence = reportJson['confidence'] as string | undefined;
    if (!confidence) {
      addError(errors, 'confidence', 'confidence is required', 'MISSING_FIELD');
    } else if (!isIn(VALID_CONFIDENCE, confidence)) {
      addError(errors, 'confidence', `Invalid confidence: "${confidence}"`, 'INVALID_ENUM');
    }

    // Validate territoryDecisions
    if (Array.isArray(territoryDecisions)) {
      const coveredCountries = new Set<string>();
      const componentCoveredCountries =
        this.getComponentTerritoryCountryCodes(componentAssessments);
      for (let i = 0; i < territoryDecisions.length; i++) {
        const td = territoryDecisions[i] as Record<string, unknown>;
        const prefix = `territoryDecisions[${i}]`;

        const cc = td['countryCode'] as string | undefined;
        if (!cc) {
          addError(errors, `${prefix}.countryCode`, 'countryCode is required', 'MISSING_FIELD');
        } else if (typeof cc === 'string' && !/^[A-Z]{2}$/.test(cc)) {
          addError(
            errors,
            `${prefix}.countryCode`,
            `Invalid countryCode: "${cc}". Must be uppercase ISO alpha-2`,
            'INVALID_COUNTRY_CODE',
          );
        } else if (typeof cc === 'string') {
          coveredCountries.add(cc);
        }

        const finalStatus = td['finalStatus'] as string | undefined;
        if (finalStatus && !isIn(VALID_TERRITORY_FINAL_STATUSES, finalStatus)) {
          addError(
            errors,
            `${prefix}.finalStatus`,
            `Invalid finalStatus: "${finalStatus}"`,
            'INVALID_ENUM',
          );
        }

        const accessPolicy = td['accessPolicy'] as string | undefined;
        if (accessPolicy && !isIn(VALID_ACCESS_POLICIES, accessPolicy)) {
          addError(
            errors,
            `${prefix}.accessPolicy`,
            `Invalid accessPolicy: "${accessPolicy}"`,
            'INVALID_ENUM',
          );
        }

        if (publicationGate === 'ALLOW' && accessPolicy === 'BLOCK') {
          addError(
            errors,
            `${prefix}.accessPolicy`,
            `publicationGate=ALLOW conflicts with accessPolicy=BLOCK for country "${cc}"`,
            'ALLOW_BLOCK_CONFLICT',
          );
        }

        const geoBlockRequired = td['geoBlockRequired'];
        const geoBlockScope = td['geoBlockScope'] as string | undefined;
        if (geoBlockRequired === true && (!geoBlockScope || geoBlockScope.trim() === '')) {
          addError(
            errors,
            `${prefix}.geoBlockScope`,
            'geoBlockRequired=true requires geoBlockScope',
            'GEO_BLOCK_SCOPE_REQUIRED',
          );
        }
        if (
          geoBlockScope &&
          typeof geoBlockScope === 'string' &&
          !isIn(VALID_GEO_BLOCK_SCOPES, geoBlockScope)
        ) {
          addError(
            errors,
            `${prefix}.geoBlockScope`,
            `Invalid geoBlockScope: "${geoBlockScope}"`,
            'INVALID_ENUM',
          );
        }

        const tdConfidence = td['confidence'] as string | undefined;
        if (tdConfidence && !isIn(VALID_CONFIDENCE, tdConfidence)) {
          addError(
            errors,
            `${prefix}.confidence`,
            `Invalid confidence: "${tdConfidence}"`,
            'INVALID_ENUM',
          );
        }
      }

      // Check all target countries are covered
      for (const country of targetCountryCodes) {
        if (!coveredCountries.has(country) && !componentCoveredCountries.has(country)) {
          addError(
            errors,
            'territoryDecisions',
            `Missing territory decision for target country: "${country}"`,
            'MISSING_COUNTRY_DECISION',
          );
        }
      }

      // Check for NOT_CHECKED entries for target countries
      for (let i = 0; i < territoryDecisions.length; i++) {
        const td = territoryDecisions[i] as Record<string, unknown>;
        if (
          td['finalStatus'] === 'NOT_CHECKED' &&
          targetCountryCodes.includes(td['countryCode'] as string)
        ) {
          addWarning(
            warnings,
            `territoryDecisions[${i}].finalStatus`,
            `Target country "${td['countryCode'] as string}" has status NOT_CHECKED`,
            'TARGET_COUNTRY_NOT_CHECKED',
          );
        }
      }

      // Check for PENDING_REVIEW
      for (let i = 0; i < territoryDecisions.length; i++) {
        const td = territoryDecisions[i] as Record<string, unknown>;
        if (td['finalStatus'] === 'PENDING_REVIEW') {
          addWarning(
            warnings,
            `territoryDecisions[${i}].finalStatus`,
            `Country "${td['countryCode'] as string}" has status PENDING_REVIEW`,
            'PENDING_REVIEW',
          );
        }
      }
    }

    // Validate languageAssessments
    if (Array.isArray(languageAssessments)) {
      const coveredLanguages = new Set<string>();
      for (let i = 0; i < languageAssessments.length; i++) {
        const la = languageAssessments[i] as Record<string, unknown>;
        const prefix = `languageAssessments[${i}]`;

        const lc = la['languageCode'];
        if (lc && typeof lc === 'string') {
          coveredLanguages.add(lc);
          if (!isIn(VALID_LANGUAGE_CODES, lc)) {
            addError(
              errors,
              `${prefix}.languageCode`,
              `Invalid languageCode: "${lc}"`,
              'INVALID_ENUM',
            );
          }
        }

        const laStatus = la['status'] as string | undefined;
        if (laStatus && !isIn(VALID_LANGUAGE_ASSESSMENT_STATUSES, laStatus)) {
          addError(
            errors,
            `${prefix}.status`,
            `Invalid language assessment status: "${laStatus}"`,
            'INVALID_ENUM',
          );
        }

        const translationOrigin = la['translationOrigin'] as string | undefined;
        if (translationOrigin && !isIn(VALID_TRANSLATION_ORIGINS, translationOrigin)) {
          addError(
            errors,
            `${prefix}.translationOrigin`,
            `Invalid translationOrigin: "${translationOrigin}"`,
            'INVALID_ENUM',
          );
        }
        if (translationOrigin === 'BIBLIARIS_TRANSLATION_FROM_INTERMEDIATE_TRANSLATION') {
          addWarning(
            warnings,
            `${prefix}.translationOrigin`,
            'BIBLIARIS_TRANSLATION_FROM_INTERMEDIATE_TRANSLATION is used — verify original rights',
            'INTERMEDIATE_TRANSLATION',
          );
        }
      }

      // Check all target languages are covered
      for (const lang of targetLanguages) {
        if (!coveredLanguages.has(lang)) {
          addError(
            errors,
            'languageAssessments',
            `Missing language assessment for target language: "${lang}"`,
            'MISSING_LANGUAGE_ASSESSMENT',
          );
        }
      }
    }

    // Validate requiredActions
    if (Array.isArray(requiredActions)) {
      for (let i = 0; i < requiredActions.length; i++) {
        const ra = requiredActions[i] as Record<string, unknown>;
        const prefix = `requiredActions[${i}]`;

        const at = ra['actionType'] as string | undefined;
        if (at && !isIn(VALID_ACTION_TYPES, at)) {
          addError(errors, `${prefix}.actionType`, `Invalid actionType: "${at}"`, 'INVALID_ENUM');
        }

        const isBlocking = ra['isBlocking'];
        if (isBlocking === true && !ra['descriptionRu']) {
          addError(
            errors,
            `${prefix}.descriptionRu`,
            'isBlocking=true requires descriptionRu',
            'BLOCKING_ACTION_NO_DESC',
          );
        }
      }
    }

    // Validate evidence
    if (Array.isArray(evidence)) {
      for (let i = 0; i < evidence.length; i++) {
        const ev = evidence[i] as Record<string, unknown>;
        const prefix = `evidence[${i}]`;

        const et = ev['evidenceType'] as string | undefined;
        if (et && !isIn(VALID_EVIDENCE_TYPES, et)) {
          addError(
            errors,
            `${prefix}.evidenceType`,
            `Invalid evidenceType: "${et}"`,
            'INVALID_ENUM',
          );
        }

        const sl = ev['sourceLevel'] as string | undefined;
        if (sl && !isIn(VALID_EVIDENCE_SOURCE_LEVELS, sl)) {
          addError(errors, `${prefix}.sourceLevel`, `Invalid sourceLevel: "${sl}"`, 'INVALID_ENUM');
        }
      }
    }

    // Validate component assessments
    if (Array.isArray(componentAssessments)) {
      for (let i = 0; i < componentAssessments.length; i++) {
        const ca = componentAssessments[i] as Record<string, unknown>;
        const prefix = `componentAssessments[${i}]`;

        const ct = ca['componentType'] as string | undefined;
        if (ct && !isIn(VALID_COMPONENT_TYPES, ct)) {
          addError(
            errors,
            `${prefix}.componentType`,
            `Invalid componentType: "${ct}"`,
            'INVALID_ENUM',
          );
        }

        const cs = ca['status'] as string | undefined;
        if (cs && !isIn(VALID_COMPONENT_STATUSES, cs)) {
          addError(errors, `${prefix}.status`, `Invalid component status: "${cs}"`, 'INVALID_ENUM');
        }

        const caa = ca['requiredAction'] as string | undefined;
        if (caa && !isIn(VALID_COMPONENT_ACTIONS, caa)) {
          addError(
            errors,
            `${prefix}.requiredAction`,
            `Invalid component requiredAction: "${caa}"`,
            'INVALID_ENUM',
          );
        }

        const caConfidence = ca['confidence'] as string | undefined;
        if (caConfidence && !isIn(VALID_CONFIDENCE, caConfidence)) {
          addError(
            errors,
            `${prefix}.confidence`,
            `Invalid confidence: "${caConfidence}"`,
            'INVALID_ENUM',
          );
        }

        const contributorRefs = ca['contributorRefs'];
        if (contributorRefs !== undefined && contributorRefs !== null) {
          if (!Array.isArray(contributorRefs)) {
            addError(
              errors,
              `${prefix}.contributorRefs`,
              'contributorRefs must be an array',
              'INVALID_TYPE',
            );
          } else {
            for (let j = 0; j < contributorRefs.length; j++) {
              const ref = contributorRefs[j] as Record<string, unknown>;
              const refPrefix = `${prefix}.contributorRefs[${j}]`;

              const contributorKey = ref['contributorKey'] as string | undefined;
              if (!contributorKey || typeof contributorKey !== 'string') {
                addError(
                  errors,
                  `${refPrefix}.contributorKey`,
                  'contributorKey is required',
                  'MISSING_FIELD',
                );
              } else if (
                validContributorKeys.size > 0 &&
                !validContributorKeys.has(contributorKey)
              ) {
                addError(
                  errors,
                  `${refPrefix}.contributorKey`,
                  `contributorKey "${contributorKey}" does not exist in top-level contributors`,
                  'INVALID_REFERENCE',
                );
              }

              const role = ref['role'] as string | undefined;
              if (role && !isIn(VALID_CONTRIBUTOR_ROLES, role)) {
                addError(
                  errors,
                  `${refPrefix}.role`,
                  `Invalid contributor role: "${role}"`,
                  'INVALID_ENUM',
                );
              }
            }
          }
        }

        const titleRu = typeof ca['titleRu'] === 'string' ? ca['titleRu'] : '';
        if (ct === 'TRANSLATION' || titleRu.toLowerCase().includes('перевод')) {
          const hasTranslator = Array.isArray(contributorRefs)
            ? contributorRefs.some((r) => (r as Record<string, unknown>)['role'] === 'TRANSLATOR')
            : false;
          if (!hasTranslator) {
            addWarning(
              warnings,
              `${prefix}.contributorRefs`,
              'TEXT_TRANSLATION component is missing a TRANSLATOR contributor reference',
              'MISSING_ROLE_WARNING',
            );
          }
        }

        if (ct === 'AUDIO_NARRATION') {
          const hasNarrator = Array.isArray(contributorRefs)
            ? contributorRefs.some((r) => (r as Record<string, unknown>)['role'] === 'NARRATOR')
            : false;
          if (!hasNarrator) {
            addWarning(
              warnings,
              `${prefix}.contributorRefs`,
              'AUDIO_NARRATION component is missing a NARRATOR contributor reference',
              'MISSING_ROLE_WARNING',
            );
          }
        }

        this.validateComponentTerritoryAssessments(
          ca['territoryAssessments'],
          prefix,
          errors,
          warnings,
          territoryDecisions,
        );
      }
    }

    // Validate source assessment
    if (sourceAssessment) {
      const sp = sourceAssessment['provider'] as string | undefined;
      if (sp && !isIn(VALID_SOURCE_PROVIDERS, sp)) {
        addError(errors, 'sourceAssessment.provider', `Invalid provider: "${sp}"`, 'INVALID_ENUM');
      }

      const stt = sourceAssessment['sourceTextType'] as string | undefined;
      if (stt && !isIn(VALID_SOURCE_TEXT_TYPES, stt)) {
        addError(
          errors,
          'sourceAssessment.sourceTextType',
          `Invalid sourceTextType: "${stt}"`,
          'INVALID_ENUM',
        );
      }

      const gs = sourceAssessment['gutenbergStatus'] as string | undefined;
      if (gs && !isIn(VALID_GUTENBERG_STATUSES, gs)) {
        addError(
          errors,
          'sourceAssessment.gutenbergStatus',
          `Invalid gutenbergStatus: "${gs}"`,
          'INVALID_ENUM',
        );
      }

      const ss = sourceAssessment['status'] as string | undefined;
      if (ss && !isIn(VALID_SOURCE_STATUSES, ss)) {
        addError(
          errors,
          'sourceAssessment.status',
          `Invalid source status: "${ss}"`,
          'INVALID_ENUM',
        );
      }
    }

    // Warnings for LOW confidence and missing nextReviewAt
    if (confidence === 'LOW') {
      addWarning(warnings, 'confidence', 'confidence is LOW', 'LOW_CONFIDENCE');
    }

    if (!reportJson['nextReviewAt']) {
      addWarning(warnings, 'nextReviewAt', 'nextReviewAt is not set', 'MISSING_NEXT_REVIEW');
    }

    return { errors, warnings };
  }

  private getComponentTerritoryCountryCodes(componentAssessments: unknown): Set<string> {
    const countryCodes = new Set<string>();
    if (!Array.isArray(componentAssessments)) return countryCodes;

    for (const component of componentAssessments) {
      if (!component || typeof component !== 'object') continue;
      const territoryAssessments = (component as Record<string, unknown>)['territoryAssessments'];
      if (!Array.isArray(territoryAssessments)) continue;

      for (const assessment of territoryAssessments) {
        if (!assessment || typeof assessment !== 'object') continue;
        const countryCode = (assessment as Record<string, unknown>)['countryCode'];
        if (typeof countryCode === 'string' && /^[A-Za-z]{2}$/.test(countryCode)) {
          countryCodes.add(countryCode.toUpperCase());
        }
      }
    }

    return countryCodes;
  }

  private validateComponentTerritoryAssessments(
    value: unknown,
    componentPrefix: string,
    errors: ValidationIssue[],
    warnings: ValidationIssue[],
    territoryDecisions: unknown,
  ): void {
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      addError(
        errors,
        `${componentPrefix}.territoryAssessments`,
        'territoryAssessments must be an array',
        'NOT_ARRAY',
      );
      return;
    }

    for (let index = 0; index < value.length; index++) {
      const assessment: unknown = value[index];
      const prefix = `${componentPrefix}.territoryAssessments[${index}]`;
      if (!assessment || typeof assessment !== 'object' || Array.isArray(assessment)) {
        addError(errors, prefix, 'territory assessment must be an object', 'INVALID_TYPE');
        continue;
      }

      const record = assessment as Record<string, unknown>;
      const countryCode = record['countryCode'];
      if (typeof countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(countryCode)) {
        addError(
          errors,
          `${prefix}.countryCode`,
          'countryCode must be a two-letter ISO alpha-2 code',
          'INVALID_COUNTRY_CODE',
        );
      }

      const status = record['status'];
      if (typeof status !== 'string' || !isIn(VALID_TERRITORY_FINAL_STATUSES, status)) {
        addError(
          errors,
          `${prefix}.status`,
          `Invalid territory assessment status: "${String(status)}"`,
          'INVALID_ENUM',
        );
      }

      const accessPolicy = record['accessPolicy'];
      if (typeof accessPolicy !== 'string' || !isIn(VALID_ACCESS_POLICIES, accessPolicy)) {
        addError(
          errors,
          `${prefix}.accessPolicy`,
          `Invalid accessPolicy: "${String(accessPolicy)}"`,
          'INVALID_ENUM',
        );
      }

      if (typeof record['geoBlockRequired'] !== 'boolean') {
        addError(
          errors,
          `${prefix}.geoBlockRequired`,
          'geoBlockRequired must be a boolean',
          'INVALID_TYPE',
        );
      }

      const reasonRequired = accessPolicy !== 'ALLOW' || record['geoBlockRequired'] === true;
      if (
        reasonRequired &&
        (typeof record['reasonRu'] !== 'string' || record['reasonRu'].trim() === '')
      ) {
        addError(
          errors,
          `${prefix}.reasonRu`,
          'reasonRu is required for restricted territory assessments',
          'MISSING_FIELD',
        );
      }

      this.validateOptionalString(record, 'legalBasisRu', prefix, errors);
      this.validateOptionalString(record, 'notesRu', prefix, errors);

      const publicDomainFromYear = record['publicDomainFromYear'];
      if (
        publicDomainFromYear !== undefined &&
        publicDomainFromYear !== null &&
        (typeof publicDomainFromYear !== 'number' || !Number.isInteger(publicDomainFromYear))
      ) {
        addError(
          errors,
          `${prefix}.publicDomainFromYear`,
          'publicDomainFromYear must be an integer or null',
          'INVALID_TYPE',
        );
      }

      const rightsExpireAt = record['rightsExpireAt'];
      if (
        rightsExpireAt !== undefined &&
        rightsExpireAt !== null &&
        (typeof rightsExpireAt !== 'string' || Number.isNaN(Date.parse(rightsExpireAt)))
      ) {
        addError(
          errors,
          `${prefix}.rightsExpireAt`,
          'rightsExpireAt must be an ISO date string or null',
          'INVALID_DATE',
        );
      }

      const sourceEvidenceIds = record['sourceEvidenceIds'];
      if (
        sourceEvidenceIds !== undefined &&
        (!Array.isArray(sourceEvidenceIds) ||
          sourceEvidenceIds.some((evidenceId) => typeof evidenceId !== 'string'))
      ) {
        addError(
          errors,
          `${prefix}.sourceEvidenceIds`,
          'sourceEvidenceIds must be an array of strings',
          'INVALID_TYPE',
        );
      }

      const assessmentConfidence = record['confidence'];
      const confidenceStr =
        typeof assessmentConfidence === 'string'
          ? assessmentConfidence
          : typeof assessmentConfidence === 'number' || typeof assessmentConfidence === 'boolean'
            ? String(assessmentConfidence)
            : '';
      if (
        assessmentConfidence !== undefined &&
        (typeof assessmentConfidence !== 'string' || !isIn(VALID_CONFIDENCE, assessmentConfidence))
      ) {
        addError(
          errors,
          `${prefix}.confidence`,
          `Invalid confidence: "${confidenceStr}"`,
          'INVALID_ENUM',
        );
      }

      this.addComponentConflictWarning(
        record,
        prefix,
        countryCode,
        accessPolicy,
        warnings,
        territoryDecisions,
      );
    }
  }

  private validateOptionalString(
    record: Record<string, unknown>,
    field: string,
    prefix: string,
    errors: ValidationIssue[],
  ): void {
    const value = record[field];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      addError(errors, `${prefix}.${field}`, `${field} must be a string`, 'INVALID_TYPE');
    }
  }

  private addComponentConflictWarning(
    assessment: Record<string, unknown>,
    prefix: string,
    countryCode: unknown,
    accessPolicy: unknown,
    warnings: ValidationIssue[],
    territoryDecisions: unknown,
  ): void {
    if (!Array.isArray(territoryDecisions) || typeof countryCode !== 'string') return;
    if (accessPolicy !== 'BLOCK' && accessPolicy !== 'REVIEW_REQUIRED') return;

    const topLevelDecision = territoryDecisions.find(
      (decision) =>
        decision &&
        typeof decision === 'object' &&
        (decision as Record<string, unknown>)['countryCode'] === countryCode.toUpperCase(),
    ) as Record<string, unknown> | undefined;

    if (topLevelDecision?.['accessPolicy'] !== 'ALLOW') return;

    addWarning(
      warnings,
      `${prefix}.accessPolicy`,
      `Component-level ${String(assessment['accessPolicy'])} overrides top-level ALLOW for ${countryCode.toUpperCase()}`,
      'COMPONENT_TERRITORY_CONFLICT',
    );
  }
}
