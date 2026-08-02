import { REQUIRED_REPORT_FIELDS } from './rights-review-required-fields';
import type { RightsReportSchemaDocument } from './rights-review-schema.registry';

const CONFIDENCE_ENUM = ['HIGH', 'MEDIUM', 'LOW'];

/** Целевые языки платформы (`SUPPORTED_LANGS`). */
const LANGUAGE_ENUM = ['en', 'es', 'fr', 'pt', 'ru'];

const ISSUE_LIST_DESCRIPTION =
  'Authoritative validation is performed by the server (RightsReviewImportValidator); ' +
  'this JSON Schema describes the structure and does not replace the server-side cross-checks.';

/**
 * Machine-readable description of the rights clearance report, version 1.0.
 * Served publicly at GET /api/rights/agent/report-schema/1.0.
 */
export const RIGHTS_REPORT_SCHEMA_1_0: RightsReportSchemaDocument = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://api.bibliaris.com/api/rights/agent/report-schema/1.0',
  title: 'Bibliaris rights clearance report',
  description: ISSUE_LIST_DESCRIPTION,
  schemaVersion: '1.0',
  type: 'object',
  additionalProperties: true,
  // WP-6.2: списки `required` во всём документе приходят из `REQUIRED_REPORT_FIELDS` —
  // одного источника с рантайм-валидатором и колонками `NOT NULL` в `schema.prisma`.
  required: [...REQUIRED_REPORT_FIELDS.root],
  properties: {
    schemaVersion: {
      type: 'string',
      const: '1.0',
      description: 'Report schema version. Must match one of the versions accepted by Bibliaris.',
    },
    intakeId: {
      type: 'string',
      format: 'uuid',
      description: 'Identifier of the Bibliaris rights intake this report answers.',
    },
    overallStatus: {
      type: 'string',
      enum: [
        'PUBLISHABLE',
        'PUBLISHABLE_AFTER_CHANGES',
        'PUBLISHABLE_WITH_GEO_RESTRICTIONS',
        'LICENSE_REQUIRED',
        'INSUFFICIENT_DATA',
        'REJECTED',
      ],
    },
    publicationGate: {
      type: 'string',
      enum: ['ALLOW', 'ALLOW_AFTER_GEO_CONFIGURATION', 'BLOCK'],
    },
    summaryRu: { type: 'string', description: 'Short summary in Russian.' },
    conclusionRu: { type: 'string', description: 'Final conclusion in Russian.' },
    confidence: { type: 'string', enum: CONFIDENCE_ENUM },
    nextReviewAt: {
      type: ['string', 'null'],
      description: 'ISO date of the next recommended re-check, or null.',
    },
    sourceAssessment: {
      type: 'object',
      additionalProperties: true,
      required: [...REQUIRED_REPORT_FIELDS.sourceAssessment],
      properties: {
        provider: { type: 'string', enum: ['PROJECT_GUTENBERG', 'OTHER', 'UNKNOWN'] },
        externalId: { type: ['string', 'null'] },
        sourceUrl: { type: ['string', 'null'] },
        sourceTitle: { type: ['string', 'null'] },
        sourceLanguage: { type: ['string', 'null'] },
        sourceTextType: {
          type: 'string',
          enum: [
            'ORIGINAL_TEXT',
            'TRANSLATION',
            'ADAPTATION',
            'ABRIDGMENT',
            'COMPILATION',
            'UNKNOWN',
          ],
        },
        gutenbergStatus: {
          type: ['string', 'null'],
          enum: ['PUBLIC_DOMAIN_US', 'POSTED_WITH_PERMISSION', 'UNCERTAIN', null],
        },
        status: {
          type: 'string',
          enum: ['ALLOWED', 'LICENSE_REQUIRED', 'COPYRIGHTED', 'UNCERTAIN', 'INSUFFICIENT_DATA'],
        },
        notesRu: { type: ['string', 'null'] },
        contributors: { type: 'array', items: { $ref: '#/$defs/contributor' } },
        licenseRefs: { type: 'array', items: { type: 'string' } },
        // WP-8.3 (R3-05): контрольная сумма файла, по которому агент делал вывод. Поле
        // **необязательное**, поэтому `schemaVersion` остаётся 1.0 (правило §8 контракта):
        // если агент её не прислал, файл прикрепляет редактор и сумму считает сервер.
        // Значение входит в content hash клиренса — не похожее на sha256 отбрасывается.
        sourceFileSha256: { type: ['string', 'null'], pattern: '^[a-fA-F0-9]{64}$' },
      },
    },
    languageAssessments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: [...REQUIRED_REPORT_FIELDS.languageAssessments],
        properties: {
          languageCode: { type: 'string', enum: LANGUAGE_ENUM },
          status: {
            type: 'string',
            enum: [
              'ALLOWED',
              'ALLOWED_AFTER_CHANGES',
              'ALLOWED_BY_LICENSE',
              'BLOCKED',
              'LICENSE_REQUIRED',
              'PENDING_REVIEW',
              'NOT_TARGETED',
            ],
          },
          translationOrigin: {
            type: 'string',
            enum: [
              'NOT_APPLICABLE_ORIGINAL',
              'GUTENBERG_TRANSLATION',
              'BIBLIARIS_TRANSLATION_FROM_ORIGINAL',
              'BIBLIARIS_TRANSLATION_FROM_INTERMEDIATE_TRANSLATION',
              'THIRD_PARTY_PUBLIC_DOMAIN_TRANSLATION',
              'THIRD_PARTY_LICENSED_TRANSLATION',
              'UNKNOWN',
            ],
          },
          translationSourceLanguage: {
            type: ['string', 'null'],
            description:
              'Language the text was translated from. Required in practice for an intermediate ' +
              'translation, because the chain of rights runs through it.',
          },
          requiresGeoBlock: {
            type: 'boolean',
            description: 'Whether this language edition needs geo-blocking on its own.',
          },
          notesRu: { type: ['string', 'null'] },
          licenseRefs: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    componentAssessments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: [...REQUIRED_REPORT_FIELDS.componentAssessments],
        properties: {
          componentType: {
            type: 'string',
            enum: [
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
            ],
          },
          titleRu: { type: 'string' },
          languageCode: {
            type: ['string', 'null'],
            enum: [...LANGUAGE_ENUM, null],
            description:
              'Language this component belongs to. Omit or set null when the component is shared ' +
              'by every language edition (a cover, an illustration).',
          },
          status: {
            type: 'string',
            enum: [
              'PUBLIC_DOMAIN',
              'OWNED',
              'LICENSED',
              'PERMISSION_GRANTED',
              'COPYRIGHTED',
              'UNCERTAIN',
              'EXCLUDED',
            ],
          },
          requiredAction: {
            type: 'string',
            enum: ['KEEP', 'REMOVE', 'REPLACE', 'RETRANSLATE', 'OBTAIN_LICENSE', 'VERIFY', 'NONE'],
          },
          confidence: { type: 'string', enum: CONFIDENCE_ENUM },
          notesRu: { type: ['string', 'null'] },
          contributorRefs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              required: ['contributorKey'],
              properties: {
                contributorKey: { type: 'string' },
                role: { type: 'string' },
              },
            },
          },
          licenseRefs: { type: 'array', items: { type: 'string' } },
          territoryAssessments: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              required: [...REQUIRED_REPORT_FIELDS.componentTerritoryAssessments],
              properties: {
                countryCode: { type: 'string', pattern: '^[A-Za-z]{2}$' },
                status: {
                  type: 'string',
                  enum: [
                    'ALLOWED',
                    'ALLOWED_AFTER_CHANGES',
                    'ALLOWED_BY_LICENSE',
                    'BLOCKED',
                    'LICENSE_REQUIRED',
                    'PENDING_REVIEW',
                    'NOT_CHECKED',
                    'NOT_TARGETED',
                  ],
                },
                accessPolicy: { type: 'string', enum: ['ALLOW', 'BLOCK', 'REVIEW_REQUIRED'] },
                geoBlockRequired: { type: 'boolean' },
                reasonRu: { type: ['string', 'null'] },
                legalBasisRu: { type: ['string', 'null'] },
                publicDomainFromYear: { type: ['integer', 'null'] },
                rightsExpireAt: { type: ['string', 'null'] },
                sourceEvidenceIds: { type: 'array', items: { type: 'string' } },
                notesRu: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
    },
    territoryDecisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: [...REQUIRED_REPORT_FIELDS.territoryDecisions],
        // WP-G.2: обоснование и уверенность требуются только от ограничивающего решения.
        // Условие описано в схеме тем же списком, что применяет сервер.
        allOf: [
          {
            if: {
              anyOf: [
                { properties: { accessPolicy: { not: { const: 'ALLOW' } } } },
                {
                  properties: { geoBlockRequired: { const: true } },
                  required: ['geoBlockRequired'],
                },
              ],
            },
            then: { required: [...REQUIRED_REPORT_FIELDS.territoryDecisionsWhenRestricted] },
          },
        ],
        properties: {
          countryCode: {
            type: 'string',
            pattern: '^[A-Za-z]{2}$',
            description: 'ISO 3166-1 alpha-2 country code; the server normalizes it to uppercase.',
          },
          finalStatus: {
            type: 'string',
            enum: [
              'ALLOWED',
              'ALLOWED_AFTER_CHANGES',
              'ALLOWED_BY_LICENSE',
              'BLOCKED',
              'LICENSE_REQUIRED',
              'PENDING_REVIEW',
              'NOT_CHECKED',
              'NOT_TARGETED',
            ],
          },
          accessPolicy: { type: 'string', enum: ['ALLOW', 'BLOCK', 'REVIEW_REQUIRED'] },
          geoBlockRequired: { type: 'boolean' },
          geoBlockScope: {
            type: 'string',
            enum: [
              'ENTIRE_BOOK',
              'LANGUAGE_EDITION',
              'TEXT_READER',
              'DOWNLOADS',
              'AUDIO',
              'SPECIFIC_ASSET',
            ],
          },
          confidence: { type: 'string', enum: CONFIDENCE_ENUM },
          reasonRu: { type: 'string' },
          licenseRefs: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    requiredActions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: [...REQUIRED_REPORT_FIELDS.requiredActions],
        properties: {
          actionType: {
            type: 'string',
            enum: [
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
            ],
          },
          descriptionRu: { type: 'string' },
          isBlocking: { type: 'boolean' },
          affectedCountryCodes: {
            type: 'array',
            items: { type: 'string', pattern: '^[A-Z]{2}$' },
          },
          // WP-5.3: агент предлагает действие, закрывает его человек. Закрытые статусы
          // (`COMPLETED`, `WAIVED`, `CANCELLED`) из контракта убраны — отчёт, закрывающий
          // собственное блокирующее действие, снимал условие №5 фазы 7 без человека (R3-03).
          suggestedStatus: { type: ['string', 'null'], enum: ['PENDING', 'IN_PROGRESS', null] },
        },
      },
    },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: [...REQUIRED_REPORT_FIELDS.evidence],
        properties: {
          evidenceType: {
            type: 'string',
            enum: [
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
            ],
          },
          sourceLevel: {
            type: 'string',
            enum: ['PRIMARY', 'OFFICIAL_BIBLIOGRAPHIC', 'SECONDARY'],
          },
          title: { type: 'string' },
          authority: { type: 'string' },
          summaryRu: { type: 'string' },
          url: { type: ['string', 'null'] },
          jurisdictionCode: { type: ['string', 'null'] },
          accessedAt: { type: ['string', 'null'] },
          relevantExcerpt: { type: ['string', 'null'] },
          licenseRef: { type: ['string', 'null'] },
        },
      },
    },
    contributors: {
      type: 'array',
      description:
        'Optional Phase 14 block: people and organizations referenced by contributorRefs.',
      items: { $ref: '#/$defs/contributor' },
    },
    licenses: {
      type: 'array',
      description:
        'Optional Phase 15 block: licenses and permissions referenced by licenseRef/licenseRefs.',
      items: {
        type: 'object',
        additionalProperties: true,
        required: [...REQUIRED_REPORT_FIELDS.licenses],
        properties: {
          key: { type: 'string', description: 'Report-local identifier used by licenseRef(s).' },
          title: { type: 'string' },
          licensor: { type: 'string' },
          licenseType: {
            type: 'string',
            enum: [
              'DIRECT_LICENSE',
              'DIRECT_PERMISSION',
              'RIGHTS_ASSIGNMENT',
              'WORK_FOR_HIRE',
              'OPEN_LICENSE',
              'PUBLIC_DOMAIN_DEDICATION',
              'OTHER',
            ],
          },
          status: {
            type: 'string',
            enum: ['DRAFT', 'PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED', 'UNCERTAIN', 'SUPERSEDED'],
          },
          territoryScope: {
            type: 'string',
            enum: ['WORLDWIDE', 'COUNTRY_LIST', 'EXCEPT_COUNTRY_LIST', 'UNKNOWN'],
          },
          countryCodes: { type: 'array', items: { type: 'string', pattern: '^[A-Z]{2}$' } },
          excludedCountryCodes: { type: 'array', items: { type: 'string', pattern: '^[A-Z]{2}$' } },
          languageCodes: { type: 'array', items: { type: 'string' } },
          mediaFormats: {
            type: 'array',
            items: {
              type: 'string',
              enum: [
                'TEXT_ONLINE',
                'TEXT_DOWNLOAD',
                'EBOOK',
                'AUDIO_STREAMING',
                'AUDIO_DOWNLOAD',
                'IMAGE',
                'PRINT',
                'OTHER',
              ],
            },
          },
          grantedAt: { type: ['string', 'null'] },
          effectiveFrom: { type: ['string', 'null'] },
          expiresAt: { type: ['string', 'null'] },
          isPerpetual: { type: 'boolean' },
          translationAllowed: { type: 'boolean' },
          attributionRequired: { type: 'boolean' },
          requiredAttributionText: { type: ['string', 'null'] },
          otherConditionsRu: { type: ['string', 'null'] },
          confidence: { type: 'string', enum: CONFIDENCE_ENUM },
          sourceEvidenceIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  $defs: {
    contributor: {
      type: 'object',
      additionalProperties: true,
      required: [...REQUIRED_REPORT_FIELDS.contributors],
      properties: {
        key: { type: 'string', description: 'Report-local identifier used by contributorRefs.' },
        role: {
          type: 'string',
          enum: [
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
          ],
        },
        roleOtherRu: { type: ['string', 'null'] },
        displayName: { type: 'string' },
        birthYear: { type: ['integer', 'null'] },
        deathYear: { type: ['integer', 'null'] },
        creditedLanguage: { type: ['string', 'null'] },
        publicDomainFromYear: { type: ['integer', 'null'] },
        sourceEvidenceIds: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};
