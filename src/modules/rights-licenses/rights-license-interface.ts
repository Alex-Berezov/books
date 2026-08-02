export enum RightsLicenseType {
  DIRECT_LICENSE = 'DIRECT_LICENSE',
  DIRECT_PERMISSION = 'DIRECT_PERMISSION',
  RIGHTS_ASSIGNMENT = 'RIGHTS_ASSIGNMENT',
  WORK_FOR_HIRE = 'WORK_FOR_HIRE',
  OPEN_LICENSE = 'OPEN_LICENSE',
  PUBLIC_DOMAIN_DEDICATION = 'PUBLIC_DOMAIN_DEDICATION',
  OTHER = 'OTHER',
}

export enum RightsLicenseStatus {
  DRAFT = 'DRAFT',
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
  EXPIRED = 'EXPIRED',
  REVOKED = 'REVOKED',
  UNCERTAIN = 'UNCERTAIN',
  SUPERSEDED = 'SUPERSEDED',
}

export enum RightsLicenseTerritoryScope {
  WORLDWIDE = 'WORLDWIDE',
  COUNTRY_LIST = 'COUNTRY_LIST',
  EXCEPT_COUNTRY_LIST = 'EXCEPT_COUNTRY_LIST',
  UNKNOWN = 'UNKNOWN',
}

export enum RightsLicenseMediaFormat {
  TEXT_ONLINE = 'TEXT_ONLINE',
  TEXT_DOWNLOAD = 'TEXT_DOWNLOAD',
  EBOOK = 'EBOOK',
  AUDIO_STREAMING = 'AUDIO_STREAMING',
  AUDIO_DOWNLOAD = 'AUDIO_DOWNLOAD',
  IMAGE = 'IMAGE',
  PRINT = 'PRINT',
  OTHER = 'OTHER',
}

export enum RightsLicenseLinkType {
  RIGHTS_PROFILE = 'RIGHTS_PROFILE',
  RIGHTS_COMPONENT = 'RIGHTS_COMPONENT',
  COMPONENT_TERRITORY_ASSESSMENT = 'COMPONENT_TERRITORY_ASSESSMENT',
  TERRITORY_DECISION = 'TERRITORY_DECISION',
  SOURCE_EDITION = 'SOURCE_EDITION',
  RIGHTS_EVIDENCE = 'RIGHTS_EVIDENCE',
  BOOK_VERSION = 'BOOK_VERSION',
}

export enum RightsLicenseEventType {
  CREATED = 'CREATED',
  UPDATED = 'UPDATED',
  ACTIVATED = 'ACTIVATED',
  REVOKED = 'REVOKED',
  EXPIRED = 'EXPIRED',
  RENEWED = 'RENEWED',
  LINKED = 'LINKED',
  UNLINKED = 'UNLINKED',
  DOCUMENT_ATTACHED = 'DOCUMENT_ATTACHED',
  IMPORTED_FROM_REVIEW = 'IMPORTED_FROM_REVIEW',
}

export type RightsLicenseConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

/** Row shape of the RightsLicense table as returned by the Prisma delegate. */
export interface RightsLicenseRecord {
  id: string;
  licenseKey: string | null;
  licenseType: RightsLicenseType;
  status: RightsLicenseStatus;
  title: string;
  licensor: string;
  licensee: string | null;
  rightsHolder: string | null;
  referenceNumber: string | null;
  grantedAt: Date | null;
  effectiveFrom: Date | null;
  expiresAt: Date | null;
  isPerpetual: boolean;
  territoryScope: RightsLicenseTerritoryScope;
  countryCodes: unknown;
  excludedCountryCodes: unknown;
  languageCodes: unknown;
  mediaFormats: unknown;
  commercialUseAllowed: boolean;
  modificationAllowed: boolean;
  translationAllowed: boolean;
  sublicensingAllowed: boolean;
  attributionRequired: boolean;
  requiredAttributionText: string | null;
  exclusive: boolean;
  revocable: boolean;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  revocationReasonRu: string | null;
  royaltyTermsRu: string | null;
  otherConditionsRu: string | null;
  notesRu: string | null;
  documentStorageKey: string | null;
  documentSha256: string | null;
  documentUrl: string | null;
  documentMediaAssetId: string | null;
  sourceEvidenceIds: unknown;
  confidence: RightsLicenseConfidence | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  links?: RightsLicenseLinkRecord[];
  events?: RightsLicenseEventRecord[];
}

export interface RightsLicenseLinkRecord {
  id: string;
  rightsLicenseId: string;
  linkType: RightsLicenseLinkType;
  rightsProfileId: string | null;
  rightsComponentId: string | null;
  componentTerritoryAssessmentId: string | null;
  territoryDecisionId: string | null;
  sourceEditionId: string | null;
  rightsEvidenceId: string | null;
  bookVersionId: string | null;
  coversCountryCodes: unknown;
  notesRu: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  rightsLicense?: RightsLicenseRecord;
}

export interface RightsLicenseEventRecord {
  id: string;
  rightsLicenseId: string;
  eventType: RightsLicenseEventType;
  previousStatus: RightsLicenseStatus | null;
  currentStatus: RightsLicenseStatus | null;
  notesRu: string | null;
  payload: unknown;
  createdByUserId: string | null;
  createdAt: Date;
}

/**
 * Minimal delegate surface used by the licenses module. The repository does not run
 * `prisma generate` locally, so the new models are reached through dynamic delegates
 * that are typed explicitly here instead of using `any`.
 */
export interface RightsLicenseDelegate {
  findMany(args?: Record<string, unknown>): Promise<RightsLicenseRecord[]>;
  findFirst(args: Record<string, unknown>): Promise<RightsLicenseRecord | null>;
  findUnique(args: Record<string, unknown>): Promise<RightsLicenseRecord | null>;
  create(args: Record<string, unknown>): Promise<RightsLicenseRecord>;
  update(args: Record<string, unknown>): Promise<RightsLicenseRecord>;
  count(args?: Record<string, unknown>): Promise<number>;
}

export interface RightsLicenseLinkDelegate {
  findMany(args?: Record<string, unknown>): Promise<RightsLicenseLinkRecord[]>;
  findFirst(args: Record<string, unknown>): Promise<RightsLicenseLinkRecord | null>;
  create(args: Record<string, unknown>): Promise<RightsLicenseLinkRecord>;
  delete(args: Record<string, unknown>): Promise<RightsLicenseLinkRecord>;
}

export interface RightsLicenseEventDelegate {
  findMany(args?: Record<string, unknown>): Promise<RightsLicenseEventRecord[]>;
  create(args: Record<string, unknown>): Promise<RightsLicenseEventRecord>;
}

/**
 * WP-10.1 (R0-01): отвязка удаляет `RightsLicenseLink` физически, поэтому удаление и запись
 * события обязаны идти одной транзакцией. Транзакционный клиент описан здесь той же
 * дельегатной парой, что и обычный: сгенерированный Prisma-клиент новых моделей не знает.
 */
export interface RightsLicenseDatabaseClient {
  rightsLicense: RightsLicenseDelegate;
  rightsLicenseLink: RightsLicenseLinkDelegate;
  rightsLicenseEvent: RightsLicenseEventDelegate;
  $transaction<T>(callback: (client: RightsLicenseDatabaseClient) => Promise<T>): Promise<T>;
}

/** Reads a `Json?` column that is expected to hold an array of strings. */
export const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
};
