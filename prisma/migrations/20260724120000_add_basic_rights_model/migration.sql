-- CreateEnum
CREATE TYPE "RightsProfileStatus" AS ENUM ('IMPORTED', 'SUPERSEDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RightsReviewStatus" AS ENUM ('IMPORTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "RightsOverallStatus" AS ENUM ('PUBLISHABLE', 'PUBLISHABLE_AFTER_CHANGES', 'PUBLISHABLE_WITH_GEO_RESTRICTIONS', 'LICENSE_REQUIRED', 'INSUFFICIENT_DATA', 'REJECTED');

-- CreateEnum
CREATE TYPE "RightsPublicationGate" AS ENUM ('ALLOW', 'ALLOW_AFTER_GEO_CONFIGURATION', 'BLOCK');

-- CreateEnum
CREATE TYPE "RightsConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "RightsAccessPolicy" AS ENUM ('ALLOW', 'BLOCK', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "TerritoryRightsStatus" AS ENUM ('ALLOWED', 'ALLOWED_AFTER_CHANGES', 'BLOCKED', 'LICENSE_REQUIRED', 'PENDING_REVIEW', 'NOT_CHECKED', 'NOT_TARGETED');

-- CreateEnum
CREATE TYPE "RightsComponentType" AS ENUM ('ORIGINAL_TEXT', 'TRANSLATION', 'ADAPTATION', 'ABRIDGMENT', 'INTRODUCTION', 'PREFACE', 'AFTERWORD', 'ANNOTATIONS', 'FOOTNOTES', 'BIOGRAPHY', 'GLOSSARY', 'INDEX', 'EDITORIAL_REVISION', 'COMPILATION_STRUCTURE', 'ILLUSTRATION', 'PHOTOGRAPH', 'MAP', 'COVER', 'TYPOGRAPHIC_LAYOUT', 'AUDIO_NARRATION', 'AUDIO_RECORDING', 'OTHER');

-- CreateEnum
CREATE TYPE "RightsComponentStatus" AS ENUM ('PUBLIC_DOMAIN', 'OWNED', 'LICENSED', 'PERMISSION_GRANTED', 'COPYRIGHTED', 'UNCERTAIN', 'EXCLUDED');

-- CreateEnum
CREATE TYPE "RightsComponentRequiredAction" AS ENUM ('KEEP', 'REMOVE', 'REPLACE', 'RETRANSLATE', 'OBTAIN_LICENSE', 'VERIFY', 'NONE');

-- CreateEnum
CREATE TYPE "RightsActionType" AS ENUM ('REMOVE_COMPONENT', 'REPLACE_COMPONENT', 'CREATE_NEW_TRANSLATION', 'TRANSLATE_FROM_ORIGINAL', 'VERIFY_TRANSLATOR', 'VERIFY_EDITION', 'OBTAIN_LICENSE', 'CONFIGURE_GEO_BLOCK', 'VERIFY_GEO_BLOCK', 'REMOVE_GUTENBERG_HEADER', 'REMOVE_GUTENBERG_FOOTER', 'REMOVE_GUTENBERG_LICENSE', 'REPLACE_COVER', 'REPLACE_ILLUSTRATIONS', 'RECHECK_LATER', 'LAWYER_REVIEW', 'OTHER');

-- CreateEnum
CREATE TYPE "RightsActionStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'WAIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RightsEvidenceType" AS ENUM ('GUTENBERG_PAGE', 'GUTENBERG_FILE_NOTICE', 'OFFICIAL_LAW', 'COURT_DECISION', 'COPYRIGHT_REGISTRY', 'RENEWAL_RECORD', 'LIBRARY_CATALOG', 'AUTHORITY_RECORD', 'LICENSE_DOCUMENT', 'PERMISSION_LETTER', 'CONTRACT', 'SCREENSHOT', 'FILE_EXCERPT', 'LEGAL_OPINION', 'SECONDARY_GUIDANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "RightsEvidenceSourceLevel" AS ENUM ('PRIMARY', 'OFFICIAL_BIBLIOGRAPHIC', 'SECONDARY');

-- CreateTable
CREATE TABLE "RightsProfile" (
    "id" TEXT NOT NULL,
    "rightsIntakeId" TEXT NOT NULL,
    "currentReviewImportId" TEXT,
    "status" "RightsProfileStatus" NOT NULL DEFAULT 'IMPORTED',
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "overallStatus" "RightsOverallStatus" NOT NULL,
    "publicationGate" "RightsPublicationGate" NOT NULL,
    "confidence" "RightsConfidence" NOT NULL,
    "summaryRu" TEXT NOT NULL,
    "conclusionRu" TEXT NOT NULL,
    "reasoningRu" TEXT,
    "nextReviewAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RightsProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceEdition" (
    "id" TEXT NOT NULL,
    "rightsProfileId" TEXT NOT NULL,
    "provider" "RightsSourceProvider" NOT NULL DEFAULT 'UNKNOWN',
    "externalId" TEXT,
    "sourceUrl" TEXT,
    "sourceTitle" TEXT,
    "sourceLanguage" TEXT,
    "sourceTextType" "RightsSourceTextType" NOT NULL DEFAULT 'UNKNOWN',
    "gutenbergStatus" TEXT,
    "status" TEXT NOT NULL,
    "notesRu" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceEdition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EditionRights" (
    "id" TEXT NOT NULL,
    "sourceEditionId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "notesRu" TEXT,
    "legalBasisRu" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EditionRights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RightsReview" (
    "id" TEXT NOT NULL,
    "rightsProfileId" TEXT NOT NULL,
    "rightsReviewImportId" TEXT NOT NULL,
    "status" "RightsReviewStatus" NOT NULL DEFAULT 'IMPORTED',
    "schemaVersion" TEXT,
    "reviewerType" TEXT NOT NULL DEFAULT 'EXTERNAL_CHATGPT_AGENT',
    "overallStatus" "RightsOverallStatus" NOT NULL,
    "publicationGate" "RightsPublicationGate" NOT NULL,
    "confidence" "RightsConfidence" NOT NULL,
    "summaryRu" TEXT NOT NULL,
    "conclusionRu" TEXT NOT NULL,
    "reasoningRu" TEXT,
    "nextReviewAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RightsReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RightsComponent" (
    "id" TEXT NOT NULL,
    "rightsProfileId" TEXT NOT NULL,
    "componentType" "RightsComponentType" NOT NULL,
    "titleRu" TEXT NOT NULL,
    "status" "RightsComponentStatus" NOT NULL,
    "requiredAction" "RightsComponentRequiredAction" NOT NULL,
    "confidence" "RightsConfidence" NOT NULL,
    "notesRu" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RightsComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TerritoryDecision" (
    "id" TEXT NOT NULL,
    "rightsProfileId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "finalStatus" "TerritoryRightsStatus" NOT NULL,
    "accessPolicy" "RightsAccessPolicy" NOT NULL,
    "geoBlockRequired" BOOLEAN NOT NULL DEFAULT false,
    "geoBlockScope" TEXT,
    "reasonRu" TEXT NOT NULL,
    "legalBasisRu" TEXT,
    "confidence" "RightsConfidence" NOT NULL,
    "nextReviewAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TerritoryDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComponentTerritoryAssessment" (
    "id" TEXT NOT NULL,
    "rightsComponentId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "status" "TerritoryRightsStatus" NOT NULL,
    "accessPolicy" "RightsAccessPolicy" NOT NULL,
    "geoBlockRequired" BOOLEAN NOT NULL DEFAULT false,
    "reasonRu" TEXT,
    "confidence" "RightsConfidence",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComponentTerritoryAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RightsEvidence" (
    "id" TEXT NOT NULL,
    "rightsProfileId" TEXT NOT NULL,
    "evidenceType" "RightsEvidenceType" NOT NULL,
    "sourceLevel" "RightsEvidenceSourceLevel" NOT NULL,
    "title" TEXT NOT NULL,
    "authority" TEXT NOT NULL,
    "url" TEXT,
    "jurisdictionCode" TEXT,
    "accessedAt" TIMESTAMP(3),
    "relevantExcerpt" TEXT,
    "summaryRu" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RightsEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RightsAction" (
    "id" TEXT NOT NULL,
    "rightsProfileId" TEXT NOT NULL,
    "actionType" "RightsActionType" NOT NULL,
    "status" "RightsActionStatus" NOT NULL DEFAULT 'PENDING',
    "descriptionRu" TEXT NOT NULL,
    "affectedCountryCodes" JSONB NOT NULL,
    "isBlocking" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RightsAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RightsProfile_rightsIntakeId_idx" ON "RightsProfile"("rightsIntakeId");
CREATE INDEX "RightsProfile_currentReviewImportId_idx" ON "RightsProfile"("currentReviewImportId");
CREATE INDEX "RightsProfile_status_idx" ON "RightsProfile"("status");
CREATE INDEX "RightsProfile_isCurrent_idx" ON "RightsProfile"("isCurrent");
CREATE INDEX "RightsProfile_overallStatus_idx" ON "RightsProfile"("overallStatus");
CREATE INDEX "RightsProfile_publicationGate_idx" ON "RightsProfile"("publicationGate");

CREATE UNIQUE INDEX "SourceEdition_rightsProfileId_key" ON "SourceEdition"("rightsProfileId");
CREATE INDEX "SourceEdition_provider_idx" ON "SourceEdition"("provider");
CREATE INDEX "SourceEdition_externalId_idx" ON "SourceEdition"("externalId");

CREATE UNIQUE INDEX "EditionRights_sourceEditionId_key" ON "EditionRights"("sourceEditionId");

CREATE UNIQUE INDEX "RightsReview_rightsReviewImportId_key" ON "RightsReview"("rightsReviewImportId");
CREATE INDEX "RightsReview_rightsProfileId_idx" ON "RightsReview"("rightsProfileId");
CREATE INDEX "RightsReview_status_idx" ON "RightsReview"("status");
CREATE INDEX "RightsReview_overallStatus_idx" ON "RightsReview"("overallStatus");
CREATE INDEX "RightsReview_publicationGate_idx" ON "RightsReview"("publicationGate");

CREATE INDEX "RightsComponent_rightsProfileId_idx" ON "RightsComponent"("rightsProfileId");
CREATE INDEX "RightsComponent_componentType_idx" ON "RightsComponent"("componentType");
CREATE INDEX "RightsComponent_status_idx" ON "RightsComponent"("status");

CREATE UNIQUE INDEX "TerritoryDecision_rightsProfileId_countryCode_key" ON "TerritoryDecision"("rightsProfileId", "countryCode");
CREATE INDEX "TerritoryDecision_rightsProfileId_idx" ON "TerritoryDecision"("rightsProfileId");
CREATE INDEX "TerritoryDecision_countryCode_idx" ON "TerritoryDecision"("countryCode");
CREATE INDEX "TerritoryDecision_finalStatus_idx" ON "TerritoryDecision"("finalStatus");
CREATE INDEX "TerritoryDecision_accessPolicy_idx" ON "TerritoryDecision"("accessPolicy");
CREATE INDEX "TerritoryDecision_geoBlockRequired_idx" ON "TerritoryDecision"("geoBlockRequired");

CREATE UNIQUE INDEX "ComponentTerritoryAssessment_rightsComponentId_countryCode_key" ON "ComponentTerritoryAssessment"("rightsComponentId", "countryCode");
CREATE INDEX "ComponentTerritoryAssessment_rightsComponentId_idx" ON "ComponentTerritoryAssessment"("rightsComponentId");
CREATE INDEX "ComponentTerritoryAssessment_countryCode_idx" ON "ComponentTerritoryAssessment"("countryCode");
CREATE INDEX "ComponentTerritoryAssessment_status_idx" ON "ComponentTerritoryAssessment"("status");

CREATE INDEX "RightsEvidence_rightsProfileId_idx" ON "RightsEvidence"("rightsProfileId");
CREATE INDEX "RightsEvidence_evidenceType_idx" ON "RightsEvidence"("evidenceType");
CREATE INDEX "RightsEvidence_sourceLevel_idx" ON "RightsEvidence"("sourceLevel");
CREATE INDEX "RightsEvidence_jurisdictionCode_idx" ON "RightsEvidence"("jurisdictionCode");

CREATE INDEX "RightsAction_rightsProfileId_idx" ON "RightsAction"("rightsProfileId");
CREATE INDEX "RightsAction_actionType_idx" ON "RightsAction"("actionType");
CREATE INDEX "RightsAction_status_idx" ON "RightsAction"("status");
CREATE INDEX "RightsAction_isBlocking_idx" ON "RightsAction"("isBlocking");

-- AddForeignKey
ALTER TABLE "RightsProfile" ADD CONSTRAINT "RightsProfile_rightsIntakeId_fkey" FOREIGN KEY ("rightsIntakeId") REFERENCES "RightsIntake"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RightsProfile" ADD CONSTRAINT "RightsProfile_currentReviewImportId_fkey" FOREIGN KEY ("currentReviewImportId") REFERENCES "RightsReviewImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceEdition" ADD CONSTRAINT "SourceEdition_rightsProfileId_fkey" FOREIGN KEY ("rightsProfileId") REFERENCES "RightsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditionRights" ADD CONSTRAINT "EditionRights_sourceEditionId_fkey" FOREIGN KEY ("sourceEditionId") REFERENCES "SourceEdition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsReview" ADD CONSTRAINT "RightsReview_rightsProfileId_fkey" FOREIGN KEY ("rightsProfileId") REFERENCES "RightsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RightsReview" ADD CONSTRAINT "RightsReview_rightsReviewImportId_fkey" FOREIGN KEY ("rightsReviewImportId") REFERENCES "RightsReviewImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsComponent" ADD CONSTRAINT "RightsComponent_rightsProfileId_fkey" FOREIGN KEY ("rightsProfileId") REFERENCES "RightsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerritoryDecision" ADD CONSTRAINT "TerritoryDecision_rightsProfileId_fkey" FOREIGN KEY ("rightsProfileId") REFERENCES "RightsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComponentTerritoryAssessment" ADD CONSTRAINT "ComponentTerritoryAssessment_rightsComponentId_fkey" FOREIGN KEY ("rightsComponentId") REFERENCES "RightsComponent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsEvidence" ADD CONSTRAINT "RightsEvidence_rightsProfileId_fkey" FOREIGN KEY ("rightsProfileId") REFERENCES "RightsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsAction" ADD CONSTRAINT "RightsAction_rightsProfileId_fkey" FOREIGN KEY ("rightsProfileId") REFERENCES "RightsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
