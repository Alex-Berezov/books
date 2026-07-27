-- Phase 15: Rights Licenses
-- Adds RightsLicense / RightsLicenseLink / RightsLicenseEvent plus the license snapshot on BookVersion.

-- CreateEnum
CREATE TYPE "RightsLicenseType" AS ENUM ('DIRECT_LICENSE', 'DIRECT_PERMISSION', 'RIGHTS_ASSIGNMENT', 'WORK_FOR_HIRE', 'OPEN_LICENSE', 'PUBLIC_DOMAIN_DEDICATION', 'OTHER');

-- CreateEnum
CREATE TYPE "RightsLicenseStatus" AS ENUM ('DRAFT', 'PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED', 'UNCERTAIN', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "RightsLicenseTerritoryScope" AS ENUM ('WORLDWIDE', 'COUNTRY_LIST', 'EXCEPT_COUNTRY_LIST', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "RightsLicenseMediaFormat" AS ENUM ('TEXT_ONLINE', 'TEXT_DOWNLOAD', 'EBOOK', 'AUDIO_STREAMING', 'AUDIO_DOWNLOAD', 'IMAGE', 'PRINT', 'OTHER');

-- CreateEnum
CREATE TYPE "RightsLicenseLinkType" AS ENUM ('RIGHTS_PROFILE', 'RIGHTS_COMPONENT', 'COMPONENT_TERRITORY_ASSESSMENT', 'TERRITORY_DECISION', 'SOURCE_EDITION', 'RIGHTS_EVIDENCE', 'BOOK_VERSION');

-- CreateEnum
CREATE TYPE "RightsLicenseEventType" AS ENUM ('CREATED', 'UPDATED', 'ACTIVATED', 'REVOKED', 'EXPIRED', 'RENEWED', 'LINKED', 'UNLINKED', 'DOCUMENT_ATTACHED', 'IMPORTED_FROM_REVIEW');

-- CreateTable
CREATE TABLE "RightsLicense" (
    "id" TEXT NOT NULL,
    "licenseKey" TEXT,
    "licenseType" "RightsLicenseType" NOT NULL DEFAULT 'DIRECT_LICENSE',
    "status" "RightsLicenseStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "licensor" TEXT NOT NULL,
    "licensee" TEXT,
    "rightsHolder" TEXT,
    "referenceNumber" TEXT,
    "grantedAt" TIMESTAMP(3),
    "effectiveFrom" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "isPerpetual" BOOLEAN NOT NULL DEFAULT false,
    "territoryScope" "RightsLicenseTerritoryScope" NOT NULL DEFAULT 'UNKNOWN',
    "countryCodes" JSONB,
    "excludedCountryCodes" JSONB,
    "languageCodes" JSONB,
    "mediaFormats" JSONB,
    "commercialUseAllowed" BOOLEAN NOT NULL DEFAULT false,
    "modificationAllowed" BOOLEAN NOT NULL DEFAULT false,
    "translationAllowed" BOOLEAN NOT NULL DEFAULT false,
    "sublicensingAllowed" BOOLEAN NOT NULL DEFAULT false,
    "attributionRequired" BOOLEAN NOT NULL DEFAULT false,
    "requiredAttributionText" TEXT,
    "exclusive" BOOLEAN NOT NULL DEFAULT false,
    "revocable" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "revocationReasonRu" TEXT,
    "royaltyTermsRu" TEXT,
    "otherConditionsRu" TEXT,
    "notesRu" TEXT,
    "documentStorageKey" TEXT,
    "documentSha256" TEXT,
    "documentUrl" TEXT,
    "documentMediaAssetId" TEXT,
    "sourceEvidenceIds" JSONB,
    "confidence" "RightsConfidence",
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RightsLicense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RightsLicenseLink" (
    "id" TEXT NOT NULL,
    "rightsLicenseId" TEXT NOT NULL,
    "linkType" "RightsLicenseLinkType" NOT NULL,
    "rightsProfileId" TEXT,
    "rightsComponentId" TEXT,
    "componentTerritoryAssessmentId" TEXT,
    "territoryDecisionId" TEXT,
    "sourceEditionId" TEXT,
    "rightsEvidenceId" TEXT,
    "bookVersionId" TEXT,
    "coversCountryCodes" JSONB,
    "notesRu" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RightsLicenseLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RightsLicenseEvent" (
    "id" TEXT NOT NULL,
    "rightsLicenseId" TEXT NOT NULL,
    "eventType" "RightsLicenseEventType" NOT NULL,
    "previousStatus" "RightsLicenseStatus",
    "currentStatus" "RightsLicenseStatus",
    "notesRu" TEXT,
    "payload" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RightsLicenseEvent_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "BookVersion"
  ADD COLUMN "rightsLicenseIds" JSONB,
  ADD COLUMN "rightsLicenseCoverageStatus" TEXT,
  ADD COLUMN "rightsLicenseCheckedAt" TIMESTAMP(3),
  ADD COLUMN "rightsLicenseUncoveredCountryCodes" JSONB,
  ADD COLUMN "rightsLicenseAttributionTextRu" TEXT;

-- CreateIndex RightsLicense
CREATE UNIQUE INDEX IF NOT EXISTS "RightsLicense_licenseKey_key" ON "RightsLicense"("licenseKey");
CREATE INDEX IF NOT EXISTS "RightsLicense_status_idx" ON "RightsLicense"("status");
CREATE INDEX IF NOT EXISTS "RightsLicense_licenseType_idx" ON "RightsLicense"("licenseType");
CREATE INDEX IF NOT EXISTS "RightsLicense_territoryScope_idx" ON "RightsLicense"("territoryScope");
CREATE INDEX IF NOT EXISTS "RightsLicense_expiresAt_idx" ON "RightsLicense"("expiresAt");
CREATE INDEX IF NOT EXISTS "RightsLicense_effectiveFrom_idx" ON "RightsLicense"("effectiveFrom");
CREATE INDEX IF NOT EXISTS "RightsLicense_documentSha256_idx" ON "RightsLicense"("documentSha256");
CREATE INDEX IF NOT EXISTS "RightsLicense_createdByUserId_idx" ON "RightsLicense"("createdByUserId");
CREATE INDEX IF NOT EXISTS "RightsLicense_revokedByUserId_idx" ON "RightsLicense"("revokedByUserId");
CREATE INDEX IF NOT EXISTS "RightsLicense_documentMediaAssetId_idx" ON "RightsLicense"("documentMediaAssetId");
CREATE INDEX IF NOT EXISTS "RightsLicense_createdAt_idx" ON "RightsLicense"("createdAt");

-- CreateIndex RightsLicenseLink
CREATE INDEX IF NOT EXISTS "RightsLicenseLink_rightsLicenseId_idx" ON "RightsLicenseLink"("rightsLicenseId");
CREATE INDEX IF NOT EXISTS "RightsLicenseLink_linkType_idx" ON "RightsLicenseLink"("linkType");
CREATE INDEX IF NOT EXISTS "RightsLicenseLink_rightsProfileId_idx" ON "RightsLicenseLink"("rightsProfileId");
CREATE INDEX IF NOT EXISTS "RightsLicenseLink_rightsComponentId_idx" ON "RightsLicenseLink"("rightsComponentId");
CREATE INDEX IF NOT EXISTS "RightsLicenseLink_componentTerritoryAssessmentId_idx" ON "RightsLicenseLink"("componentTerritoryAssessmentId");
CREATE INDEX IF NOT EXISTS "RightsLicenseLink_territoryDecisionId_idx" ON "RightsLicenseLink"("territoryDecisionId");
CREATE INDEX IF NOT EXISTS "RightsLicenseLink_sourceEditionId_idx" ON "RightsLicenseLink"("sourceEditionId");
CREATE INDEX IF NOT EXISTS "RightsLicenseLink_rightsEvidenceId_idx" ON "RightsLicenseLink"("rightsEvidenceId");
CREATE INDEX IF NOT EXISTS "RightsLicenseLink_bookVersionId_idx" ON "RightsLicenseLink"("bookVersionId");
CREATE INDEX IF NOT EXISTS "RightsLicenseLink_createdByUserId_idx" ON "RightsLicenseLink"("createdByUserId");

-- CreateIndex RightsLicenseEvent
CREATE INDEX IF NOT EXISTS "RightsLicenseEvent_rightsLicenseId_idx" ON "RightsLicenseEvent"("rightsLicenseId");
CREATE INDEX IF NOT EXISTS "RightsLicenseEvent_eventType_idx" ON "RightsLicenseEvent"("eventType");
CREATE INDEX IF NOT EXISTS "RightsLicenseEvent_createdAt_idx" ON "RightsLicenseEvent"("createdAt");
CREATE INDEX IF NOT EXISTS "RightsLicenseEvent_createdByUserId_idx" ON "RightsLicenseEvent"("createdByUserId");

-- CreateIndex BookVersion
CREATE INDEX IF NOT EXISTS "BookVersion_rightsLicenseCoverageStatus_idx" ON "BookVersion"("rightsLicenseCoverageStatus");

-- AddForeignKey
ALTER TABLE "RightsLicense" ADD CONSTRAINT "RightsLicense_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsLicense" ADD CONSTRAINT "RightsLicense_documentMediaAssetId_fkey" FOREIGN KEY ("documentMediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsLicense" ADD CONSTRAINT "RightsLicense_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsLicenseLink" ADD CONSTRAINT "RightsLicenseLink_rightsLicenseId_fkey" FOREIGN KEY ("rightsLicenseId") REFERENCES "RightsLicense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsLicenseLink" ADD CONSTRAINT "RightsLicenseLink_rightsProfileId_fkey" FOREIGN KEY ("rightsProfileId") REFERENCES "RightsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsLicenseLink" ADD CONSTRAINT "RightsLicenseLink_rightsComponentId_fkey" FOREIGN KEY ("rightsComponentId") REFERENCES "RightsComponent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsLicenseLink" ADD CONSTRAINT "RightsLicenseLink_componentTerritoryAssessmentId_fkey" FOREIGN KEY ("componentTerritoryAssessmentId") REFERENCES "ComponentTerritoryAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsLicenseLink" ADD CONSTRAINT "RightsLicenseLink_territoryDecisionId_fkey" FOREIGN KEY ("territoryDecisionId") REFERENCES "TerritoryDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsLicenseLink" ADD CONSTRAINT "RightsLicenseLink_sourceEditionId_fkey" FOREIGN KEY ("sourceEditionId") REFERENCES "SourceEdition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsLicenseLink" ADD CONSTRAINT "RightsLicenseLink_rightsEvidenceId_fkey" FOREIGN KEY ("rightsEvidenceId") REFERENCES "RightsEvidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsLicenseLink" ADD CONSTRAINT "RightsLicenseLink_bookVersionId_fkey" FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsLicenseLink" ADD CONSTRAINT "RightsLicenseLink_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsLicenseEvent" ADD CONSTRAINT "RightsLicenseEvent_rightsLicenseId_fkey" FOREIGN KEY ("rightsLicenseId") REFERENCES "RightsLicense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsLicenseEvent" ADD CONSTRAINT "RightsLicenseEvent_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
