-- Phase 16: Rights Claims / DMCA
-- Adds RightsClaim / RightsClaimComponent / RightsClaimAccessBlock / RightsClaimAttachment /
-- RightsClaimEvent plus the claim-block snapshot flags on BookVersion.

-- CreateEnum
CREATE TYPE "RightsClaimType" AS ENUM ('DMCA_TAKEDOWN', 'COPYRIGHT_INFRINGEMENT', 'LICENSE_VIOLATION', 'ATTRIBUTION_MISSING', 'TERRITORY_VIOLATION', 'TRADEMARK', 'PRIVACY_PERSONAL_DATA', 'DEFAMATION', 'COUNTER_NOTICE', 'OTHER');

-- CreateEnum
CREATE TYPE "RightsClaimStatus" AS ENUM ('RECEIVED', 'UNDER_REVIEW', 'ACTION_REQUIRED', 'AWAITING_CLAIMANT', 'CONTENT_REMOVED', 'CONTENT_RESTRICTED', 'COUNTER_NOTICE_FILED', 'ESCALATED_TO_LAWYER', 'RESOLVED_VALID', 'RESOLVED_INVALID', 'WITHDRAWN', 'CLOSED');

-- CreateEnum
CREATE TYPE "RightsClaimSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "RightsClaimChannel" AS ENUM ('EMAIL', 'WEB_FORM', 'POSTAL', 'PHONE', 'LEGAL_COUNSEL', 'PLATFORM_NOTICE', 'OTHER');

-- CreateEnum
CREATE TYPE "RightsClaimantType" AS ENUM ('RIGHTS_HOLDER', 'AUTHOR', 'PUBLISHER', 'AGENT', 'LAW_FIRM', 'COLLECTING_SOCIETY', 'PLATFORM', 'INDIVIDUAL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "RightsClaimResolution" AS ENUM ('VALID_CONTENT_REMOVED', 'VALID_LICENSE_OBTAINED', 'VALID_GEO_RESTRICTED', 'VALID_ATTRIBUTION_ADDED', 'INVALID_REJECTED', 'WITHDRAWN_BY_CLAIMANT', 'COUNTER_NOTICE_UPHELD', 'NO_ACTION_NEEDED', 'OTHER');

-- CreateEnum
CREATE TYPE "RightsClaimBlockStatus" AS ENUM ('ACTIVE', 'LIFTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RightsClaimAttachmentType" AS ENUM ('CLAIM_NOTICE', 'EVIDENCE', 'POWER_OF_ATTORNEY', 'LICENSE_DOCUMENT', 'CORRESPONDENCE', 'COUNTER_NOTICE', 'RESPONSE_LETTER', 'LEGAL_OPINION', 'SCREENSHOT', 'OTHER');

-- CreateEnum
CREATE TYPE "RightsClaimEventType" AS ENUM ('CREATED', 'UPDATED', 'STATUS_CHANGED', 'ASSIGNED', 'BLOCK_APPLIED', 'BLOCK_LIFTED', 'BLOCK_EXPIRED', 'RESPONSE_RECORDED', 'COUNTER_NOTICE_RECORDED', 'RESOLVED', 'REOPENED', 'ESCALATED', 'DEADLINE_CHANGED', 'COMPONENT_LINKED', 'COMPONENT_UNLINKED', 'ATTACHMENT_ADDED', 'ATTACHMENT_REMOVED', 'VERSION_UNPUBLISHED');

-- CreateTable
CREATE TABLE "RightsClaim" (
    "id" TEXT NOT NULL,
    "claimNumber" TEXT NOT NULL,
    "claimType" "RightsClaimType" NOT NULL,
    "status" "RightsClaimStatus" NOT NULL DEFAULT 'RECEIVED',
    "severity" "RightsClaimSeverity" NOT NULL DEFAULT 'MEDIUM',
    "channel" "RightsClaimChannel" NOT NULL DEFAULT 'EMAIL',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadlineAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "claimantName" TEXT NOT NULL,
    "claimantType" "RightsClaimantType" NOT NULL DEFAULT 'UNKNOWN',
    "claimantOrganization" TEXT,
    "claimantEmail" TEXT,
    "claimantPhone" TEXT,
    "claimantAddress" TEXT,
    "claimantIsAuthorized" BOOLEAN NOT NULL DEFAULT false,
    "claimantPersonId" TEXT,
    "bookId" TEXT,
    "bookVersionId" TEXT,
    "rightsProfileId" TEXT,
    "rightsIntakeId" TEXT,
    "mediaAssetId" TEXT,
    "affectedCountryCodes" JSONB,
    "affectedLanguages" JSONB,
    "claimedWorkTitle" TEXT,
    "claimedWorkAuthor" TEXT,
    "claimedRightsDescriptionRu" TEXT,
    "descriptionRu" TEXT NOT NULL,
    "infringingUrls" JSONB,
    "goodFaithStatement" BOOLEAN NOT NULL DEFAULT false,
    "swornStatement" BOOLEAN NOT NULL DEFAULT false,
    "originalNoticeText" TEXT,
    "originalNoticeUrl" TEXT,
    "assignedToUserId" TEXT,
    "internalNotesRu" TEXT,
    "blocksPublication" BOOLEAN NOT NULL DEFAULT true,
    "blocksPublicationOverrideReasonRu" TEXT,
    "requiresLawyerReview" BOOLEAN NOT NULL DEFAULT false,
    "responseSentAt" TIMESTAMP(3),
    "responseChannel" "RightsClaimChannel",
    "responseTextRu" TEXT,
    "responseByUserId" TEXT,
    "counterNoticeReceivedAt" TIMESTAMP(3),
    "counterNoticeClaimantName" TEXT,
    "counterNoticeTextRu" TEXT,
    "resolution" "RightsClaimResolution",
    "resolutionNotesRu" TEXT,
    "resolvedByUserId" TEXT,
    "parentClaimId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RightsClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RightsClaimComponent" (
    "id" TEXT NOT NULL,
    "rightsClaimId" TEXT NOT NULL,
    "rightsComponentId" TEXT,
    "componentType" "RightsComponentType",
    "titleRu" TEXT,
    "notesRu" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RightsClaimComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RightsClaimAccessBlock" (
    "id" TEXT NOT NULL,
    "rightsClaimId" TEXT NOT NULL,
    "bookId" TEXT,
    "bookVersionId" TEXT,
    "scope" "GeoBlockScope" NOT NULL,
    "countryCode" TEXT,
    "status" "RightsClaimBlockStatus" NOT NULL DEFAULT 'ACTIVE',
    "reasonRu" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedByUserId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "liftedAt" TIMESTAMP(3),
    "liftedByUserId" TEXT,
    "liftReasonRu" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RightsClaimAccessBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RightsClaimAttachment" (
    "id" TEXT NOT NULL,
    "rightsClaimId" TEXT NOT NULL,
    "attachmentType" "RightsClaimAttachmentType" NOT NULL DEFAULT 'EVIDENCE',
    "title" TEXT NOT NULL,
    "fileName" TEXT,
    "mediaAssetId" TEXT,
    "storageKey" TEXT,
    "url" TEXT,
    "sha256" TEXT,
    "contentType" TEXT,
    "sizeBytes" INTEGER,
    "notesRu" TEXT,
    "uploadedByUserId" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "removedAt" TIMESTAMP(3),
    "removedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RightsClaimAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RightsClaimEvent" (
    "id" TEXT NOT NULL,
    "rightsClaimId" TEXT NOT NULL,
    "eventType" "RightsClaimEventType" NOT NULL,
    "previousStatus" "RightsClaimStatus",
    "currentStatus" "RightsClaimStatus",
    "notesRu" TEXT,
    "payload" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RightsClaimEvent_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "BookVersion" ADD COLUMN     "rightsClaimBlockActive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rightsClaimBlockAppliedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "RightsClaim_claimNumber_key" ON "RightsClaim"("claimNumber");

-- CreateIndex
CREATE INDEX "RightsClaim_claimNumber_idx" ON "RightsClaim"("claimNumber");

-- CreateIndex
CREATE INDEX "RightsClaim_status_idx" ON "RightsClaim"("status");

-- CreateIndex
CREATE INDEX "RightsClaim_claimType_idx" ON "RightsClaim"("claimType");

-- CreateIndex
CREATE INDEX "RightsClaim_severity_idx" ON "RightsClaim"("severity");

-- CreateIndex
CREATE INDEX "RightsClaim_bookId_idx" ON "RightsClaim"("bookId");

-- CreateIndex
CREATE INDEX "RightsClaim_bookVersionId_idx" ON "RightsClaim"("bookVersionId");

-- CreateIndex
CREATE INDEX "RightsClaim_rightsProfileId_idx" ON "RightsClaim"("rightsProfileId");

-- CreateIndex
CREATE INDEX "RightsClaim_rightsIntakeId_idx" ON "RightsClaim"("rightsIntakeId");

-- CreateIndex
CREATE INDEX "RightsClaim_assignedToUserId_idx" ON "RightsClaim"("assignedToUserId");

-- CreateIndex
CREATE INDEX "RightsClaim_claimantPersonId_idx" ON "RightsClaim"("claimantPersonId");

-- CreateIndex
CREATE INDEX "RightsClaim_deadlineAt_idx" ON "RightsClaim"("deadlineAt");

-- CreateIndex
CREATE INDEX "RightsClaim_receivedAt_idx" ON "RightsClaim"("receivedAt");

-- CreateIndex
CREATE INDEX "RightsClaim_resolvedAt_idx" ON "RightsClaim"("resolvedAt");

-- CreateIndex
CREATE INDEX "RightsClaim_blocksPublication_idx" ON "RightsClaim"("blocksPublication");

-- CreateIndex
CREATE INDEX "RightsClaim_requiresLawyerReview_idx" ON "RightsClaim"("requiresLawyerReview");

-- CreateIndex
CREATE INDEX "RightsClaim_parentClaimId_idx" ON "RightsClaim"("parentClaimId");

-- CreateIndex
CREATE INDEX "RightsClaim_createdByUserId_idx" ON "RightsClaim"("createdByUserId");

-- CreateIndex
CREATE INDEX "RightsClaim_responseByUserId_idx" ON "RightsClaim"("responseByUserId");

-- CreateIndex
CREATE INDEX "RightsClaim_resolvedByUserId_idx" ON "RightsClaim"("resolvedByUserId");

-- CreateIndex
CREATE INDEX "RightsClaim_mediaAssetId_idx" ON "RightsClaim"("mediaAssetId");

-- CreateIndex
CREATE INDEX "RightsClaimComponent_rightsClaimId_idx" ON "RightsClaimComponent"("rightsClaimId");

-- CreateIndex
CREATE INDEX "RightsClaimComponent_rightsComponentId_idx" ON "RightsClaimComponent"("rightsComponentId");

-- CreateIndex
CREATE INDEX "RightsClaimComponent_componentType_idx" ON "RightsClaimComponent"("componentType");

-- CreateIndex
CREATE INDEX "RightsClaimAccessBlock_rightsClaimId_idx" ON "RightsClaimAccessBlock"("rightsClaimId");

-- CreateIndex
CREATE INDEX "RightsClaimAccessBlock_bookId_status_idx" ON "RightsClaimAccessBlock"("bookId", "status");

-- CreateIndex
CREATE INDEX "RightsClaimAccessBlock_bookVersionId_status_idx" ON "RightsClaimAccessBlock"("bookVersionId", "status");

-- CreateIndex
CREATE INDEX "RightsClaimAccessBlock_countryCode_idx" ON "RightsClaimAccessBlock"("countryCode");

-- CreateIndex
CREATE INDEX "RightsClaimAccessBlock_scope_idx" ON "RightsClaimAccessBlock"("scope");

-- CreateIndex
CREATE INDEX "RightsClaimAccessBlock_status_idx" ON "RightsClaimAccessBlock"("status");

-- CreateIndex
CREATE INDEX "RightsClaimAccessBlock_expiresAt_idx" ON "RightsClaimAccessBlock"("expiresAt");

-- CreateIndex
CREATE INDEX "RightsClaimAccessBlock_appliedByUserId_idx" ON "RightsClaimAccessBlock"("appliedByUserId");

-- CreateIndex
CREATE INDEX "RightsClaimAccessBlock_liftedByUserId_idx" ON "RightsClaimAccessBlock"("liftedByUserId");

-- CreateIndex
CREATE INDEX "RightsClaimAttachment_rightsClaimId_idx" ON "RightsClaimAttachment"("rightsClaimId");

-- CreateIndex
CREATE INDEX "RightsClaimAttachment_attachmentType_idx" ON "RightsClaimAttachment"("attachmentType");

-- CreateIndex
CREATE INDEX "RightsClaimAttachment_mediaAssetId_idx" ON "RightsClaimAttachment"("mediaAssetId");

-- CreateIndex
CREATE INDEX "RightsClaimAttachment_sha256_idx" ON "RightsClaimAttachment"("sha256");

-- CreateIndex
CREATE INDEX "RightsClaimAttachment_isDeleted_idx" ON "RightsClaimAttachment"("isDeleted");

-- CreateIndex
CREATE INDEX "RightsClaimAttachment_uploadedByUserId_idx" ON "RightsClaimAttachment"("uploadedByUserId");

-- CreateIndex
CREATE INDEX "RightsClaimAttachment_removedByUserId_idx" ON "RightsClaimAttachment"("removedByUserId");

-- CreateIndex
CREATE INDEX "RightsClaimEvent_rightsClaimId_idx" ON "RightsClaimEvent"("rightsClaimId");

-- CreateIndex
CREATE INDEX "RightsClaimEvent_eventType_idx" ON "RightsClaimEvent"("eventType");

-- CreateIndex
CREATE INDEX "RightsClaimEvent_createdAt_idx" ON "RightsClaimEvent"("createdAt");

-- CreateIndex
CREATE INDEX "RightsClaimEvent_createdByUserId_idx" ON "RightsClaimEvent"("createdByUserId");

-- CreateIndex
CREATE INDEX "BookVersion_rightsClaimBlockActive_idx" ON "BookVersion"("rightsClaimBlockActive");

-- AddForeignKey
ALTER TABLE "RightsClaim" ADD CONSTRAINT "RightsClaim_claimantPersonId_fkey" FOREIGN KEY ("claimantPersonId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsClaim" ADD CONSTRAINT "RightsClaim_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsClaim" ADD CONSTRAINT "RightsClaim_bookVersionId_fkey" FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsClaim" ADD CONSTRAINT "RightsClaim_rightsProfileId_fkey" FOREIGN KEY ("rightsProfileId") REFERENCES "RightsProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsClaim" ADD CONSTRAINT "RightsClaim_rightsIntakeId_fkey" FOREIGN KEY ("rightsIntakeId") REFERENCES "RightsIntake"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsClaim" ADD CONSTRAINT "RightsClaim_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsClaim" ADD CONSTRAINT "RightsClaim_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsClaim" ADD CONSTRAINT "RightsClaim_responseByUserId_fkey" FOREIGN KEY ("responseByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsClaim" ADD CONSTRAINT "RightsClaim_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsClaim" ADD CONSTRAINT "RightsClaim_parentClaimId_fkey" FOREIGN KEY ("parentClaimId") REFERENCES "RightsClaim"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsClaim" ADD CONSTRAINT "RightsClaim_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsClaimComponent" ADD CONSTRAINT "RightsClaimComponent_rightsClaimId_fkey" FOREIGN KEY ("rightsClaimId") REFERENCES "RightsClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsClaimComponent" ADD CONSTRAINT "RightsClaimComponent_rightsComponentId_fkey" FOREIGN KEY ("rightsComponentId") REFERENCES "RightsComponent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsClaimAccessBlock" ADD CONSTRAINT "RightsClaimAccessBlock_rightsClaimId_fkey" FOREIGN KEY ("rightsClaimId") REFERENCES "RightsClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsClaimAccessBlock" ADD CONSTRAINT "RightsClaimAccessBlock_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsClaimAccessBlock" ADD CONSTRAINT "RightsClaimAccessBlock_bookVersionId_fkey" FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsClaimAccessBlock" ADD CONSTRAINT "RightsClaimAccessBlock_appliedByUserId_fkey" FOREIGN KEY ("appliedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsClaimAccessBlock" ADD CONSTRAINT "RightsClaimAccessBlock_liftedByUserId_fkey" FOREIGN KEY ("liftedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsClaimAttachment" ADD CONSTRAINT "RightsClaimAttachment_rightsClaimId_fkey" FOREIGN KEY ("rightsClaimId") REFERENCES "RightsClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsClaimAttachment" ADD CONSTRAINT "RightsClaimAttachment_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsClaimAttachment" ADD CONSTRAINT "RightsClaimAttachment_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsClaimAttachment" ADD CONSTRAINT "RightsClaimAttachment_removedByUserId_fkey" FOREIGN KEY ("removedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsClaimEvent" ADD CONSTRAINT "RightsClaimEvent_rightsClaimId_fkey" FOREIGN KEY ("rightsClaimId") REFERENCES "RightsClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsClaimEvent" ADD CONSTRAINT "RightsClaimEvent_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
