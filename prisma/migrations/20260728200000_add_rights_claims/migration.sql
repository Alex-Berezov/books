-- Phase 16: Rights Claims / DMCA
-- Adds RightsClaim / RightsClaimComponent / RightsClaimAccessBlock / RightsClaimAttachment /
-- RightsClaimEvent plus the claim-block snapshot flags on BookVersion.
--
-- Every statement is idempotent. Prisma does not wrap a migration file in a single transaction,
-- so the first production attempt (2026-07-28) left the enums, tables, indexes and BookVersion
-- columns in place and died on the first foreign key, which references the `Person` table that
-- was missing because of the Phase 14 drift (see 20260728190000_repair_phase14_person_model).
-- Guarding every statement lets this migration be re-applied over that partial state.

-- CreateEnum
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsClaimType') THEN
    CREATE TYPE "RightsClaimType" AS ENUM ('DMCA_TAKEDOWN', 'COPYRIGHT_INFRINGEMENT', 'LICENSE_VIOLATION', 'ATTRIBUTION_MISSING', 'TERRITORY_VIOLATION', 'TRADEMARK', 'PRIVACY_PERSONAL_DATA', 'DEFAMATION', 'COUNTER_NOTICE', 'OTHER');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsClaimStatus') THEN
    CREATE TYPE "RightsClaimStatus" AS ENUM ('RECEIVED', 'UNDER_REVIEW', 'ACTION_REQUIRED', 'AWAITING_CLAIMANT', 'CONTENT_REMOVED', 'CONTENT_RESTRICTED', 'COUNTER_NOTICE_FILED', 'ESCALATED_TO_LAWYER', 'RESOLVED_VALID', 'RESOLVED_INVALID', 'WITHDRAWN', 'CLOSED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsClaimSeverity') THEN
    CREATE TYPE "RightsClaimSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsClaimChannel') THEN
    CREATE TYPE "RightsClaimChannel" AS ENUM ('EMAIL', 'WEB_FORM', 'POSTAL', 'PHONE', 'LEGAL_COUNSEL', 'PLATFORM_NOTICE', 'OTHER');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsClaimantType') THEN
    CREATE TYPE "RightsClaimantType" AS ENUM ('RIGHTS_HOLDER', 'AUTHOR', 'PUBLISHER', 'AGENT', 'LAW_FIRM', 'COLLECTING_SOCIETY', 'PLATFORM', 'INDIVIDUAL', 'UNKNOWN');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsClaimResolution') THEN
    CREATE TYPE "RightsClaimResolution" AS ENUM ('VALID_CONTENT_REMOVED', 'VALID_LICENSE_OBTAINED', 'VALID_GEO_RESTRICTED', 'VALID_ATTRIBUTION_ADDED', 'INVALID_REJECTED', 'WITHDRAWN_BY_CLAIMANT', 'COUNTER_NOTICE_UPHELD', 'NO_ACTION_NEEDED', 'OTHER');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsClaimBlockStatus') THEN
    CREATE TYPE "RightsClaimBlockStatus" AS ENUM ('ACTIVE', 'LIFTED', 'EXPIRED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsClaimAttachmentType') THEN
    CREATE TYPE "RightsClaimAttachmentType" AS ENUM ('CLAIM_NOTICE', 'EVIDENCE', 'POWER_OF_ATTORNEY', 'LICENSE_DOCUMENT', 'CORRESPONDENCE', 'COUNTER_NOTICE', 'RESPONSE_LETTER', 'LEGAL_OPINION', 'SCREENSHOT', 'OTHER');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsClaimEventType') THEN
    CREATE TYPE "RightsClaimEventType" AS ENUM ('CREATED', 'UPDATED', 'STATUS_CHANGED', 'ASSIGNED', 'BLOCK_APPLIED', 'BLOCK_LIFTED', 'BLOCK_EXPIRED', 'RESPONSE_RECORDED', 'COUNTER_NOTICE_RECORDED', 'RESOLVED', 'REOPENED', 'ESCALATED', 'DEADLINE_CHANGED', 'COMPONENT_LINKED', 'COMPONENT_UNLINKED', 'ATTACHMENT_ADDED', 'ATTACHMENT_REMOVED', 'VERSION_UNPUBLISHED');
  END IF;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "RightsClaim" (
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
CREATE TABLE IF NOT EXISTS "RightsClaimComponent" (
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
CREATE TABLE IF NOT EXISTS "RightsClaimAccessBlock" (
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
CREATE TABLE IF NOT EXISTS "RightsClaimAttachment" (
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
CREATE TABLE IF NOT EXISTS "RightsClaimEvent" (
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
ALTER TABLE "BookVersion" ADD COLUMN IF NOT EXISTS "rightsClaimBlockActive" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BookVersion" ADD COLUMN IF NOT EXISTS "rightsClaimBlockAppliedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "RightsClaim_claimNumber_key" ON "RightsClaim"("claimNumber");
CREATE INDEX IF NOT EXISTS "RightsClaim_claimNumber_idx" ON "RightsClaim"("claimNumber");
CREATE INDEX IF NOT EXISTS "RightsClaim_status_idx" ON "RightsClaim"("status");
CREATE INDEX IF NOT EXISTS "RightsClaim_claimType_idx" ON "RightsClaim"("claimType");
CREATE INDEX IF NOT EXISTS "RightsClaim_severity_idx" ON "RightsClaim"("severity");
CREATE INDEX IF NOT EXISTS "RightsClaim_bookId_idx" ON "RightsClaim"("bookId");
CREATE INDEX IF NOT EXISTS "RightsClaim_bookVersionId_idx" ON "RightsClaim"("bookVersionId");
CREATE INDEX IF NOT EXISTS "RightsClaim_rightsProfileId_idx" ON "RightsClaim"("rightsProfileId");
CREATE INDEX IF NOT EXISTS "RightsClaim_rightsIntakeId_idx" ON "RightsClaim"("rightsIntakeId");
CREATE INDEX IF NOT EXISTS "RightsClaim_assignedToUserId_idx" ON "RightsClaim"("assignedToUserId");
CREATE INDEX IF NOT EXISTS "RightsClaim_claimantPersonId_idx" ON "RightsClaim"("claimantPersonId");
CREATE INDEX IF NOT EXISTS "RightsClaim_deadlineAt_idx" ON "RightsClaim"("deadlineAt");
CREATE INDEX IF NOT EXISTS "RightsClaim_receivedAt_idx" ON "RightsClaim"("receivedAt");
CREATE INDEX IF NOT EXISTS "RightsClaim_resolvedAt_idx" ON "RightsClaim"("resolvedAt");
CREATE INDEX IF NOT EXISTS "RightsClaim_blocksPublication_idx" ON "RightsClaim"("blocksPublication");
CREATE INDEX IF NOT EXISTS "RightsClaim_requiresLawyerReview_idx" ON "RightsClaim"("requiresLawyerReview");
CREATE INDEX IF NOT EXISTS "RightsClaim_parentClaimId_idx" ON "RightsClaim"("parentClaimId");
CREATE INDEX IF NOT EXISTS "RightsClaim_createdByUserId_idx" ON "RightsClaim"("createdByUserId");
CREATE INDEX IF NOT EXISTS "RightsClaim_responseByUserId_idx" ON "RightsClaim"("responseByUserId");
CREATE INDEX IF NOT EXISTS "RightsClaim_resolvedByUserId_idx" ON "RightsClaim"("resolvedByUserId");
CREATE INDEX IF NOT EXISTS "RightsClaim_mediaAssetId_idx" ON "RightsClaim"("mediaAssetId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RightsClaimComponent_rightsClaimId_idx" ON "RightsClaimComponent"("rightsClaimId");
CREATE INDEX IF NOT EXISTS "RightsClaimComponent_rightsComponentId_idx" ON "RightsClaimComponent"("rightsComponentId");
CREATE INDEX IF NOT EXISTS "RightsClaimComponent_componentType_idx" ON "RightsClaimComponent"("componentType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RightsClaimAccessBlock_rightsClaimId_idx" ON "RightsClaimAccessBlock"("rightsClaimId");
CREATE INDEX IF NOT EXISTS "RightsClaimAccessBlock_bookId_status_idx" ON "RightsClaimAccessBlock"("bookId", "status");
CREATE INDEX IF NOT EXISTS "RightsClaimAccessBlock_bookVersionId_status_idx" ON "RightsClaimAccessBlock"("bookVersionId", "status");
CREATE INDEX IF NOT EXISTS "RightsClaimAccessBlock_countryCode_idx" ON "RightsClaimAccessBlock"("countryCode");
CREATE INDEX IF NOT EXISTS "RightsClaimAccessBlock_scope_idx" ON "RightsClaimAccessBlock"("scope");
CREATE INDEX IF NOT EXISTS "RightsClaimAccessBlock_status_idx" ON "RightsClaimAccessBlock"("status");
CREATE INDEX IF NOT EXISTS "RightsClaimAccessBlock_expiresAt_idx" ON "RightsClaimAccessBlock"("expiresAt");
CREATE INDEX IF NOT EXISTS "RightsClaimAccessBlock_appliedByUserId_idx" ON "RightsClaimAccessBlock"("appliedByUserId");
CREATE INDEX IF NOT EXISTS "RightsClaimAccessBlock_liftedByUserId_idx" ON "RightsClaimAccessBlock"("liftedByUserId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RightsClaimAttachment_rightsClaimId_idx" ON "RightsClaimAttachment"("rightsClaimId");
CREATE INDEX IF NOT EXISTS "RightsClaimAttachment_attachmentType_idx" ON "RightsClaimAttachment"("attachmentType");
CREATE INDEX IF NOT EXISTS "RightsClaimAttachment_mediaAssetId_idx" ON "RightsClaimAttachment"("mediaAssetId");
CREATE INDEX IF NOT EXISTS "RightsClaimAttachment_sha256_idx" ON "RightsClaimAttachment"("sha256");
CREATE INDEX IF NOT EXISTS "RightsClaimAttachment_isDeleted_idx" ON "RightsClaimAttachment"("isDeleted");
CREATE INDEX IF NOT EXISTS "RightsClaimAttachment_uploadedByUserId_idx" ON "RightsClaimAttachment"("uploadedByUserId");
CREATE INDEX IF NOT EXISTS "RightsClaimAttachment_removedByUserId_idx" ON "RightsClaimAttachment"("removedByUserId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RightsClaimEvent_rightsClaimId_idx" ON "RightsClaimEvent"("rightsClaimId");
CREATE INDEX IF NOT EXISTS "RightsClaimEvent_eventType_idx" ON "RightsClaimEvent"("eventType");
CREATE INDEX IF NOT EXISTS "RightsClaimEvent_createdAt_idx" ON "RightsClaimEvent"("createdAt");
CREATE INDEX IF NOT EXISTS "RightsClaimEvent_createdByUserId_idx" ON "RightsClaimEvent"("createdByUserId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BookVersion_rightsClaimBlockActive_idx" ON "BookVersion"("rightsClaimBlockActive");

-- AddForeignKey (idempotent — pg has no ADD CONSTRAINT IF NOT EXISTS)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaim_claimantPersonId_fkey') THEN
    ALTER TABLE "RightsClaim" ADD CONSTRAINT "RightsClaim_claimantPersonId_fkey" FOREIGN KEY ("claimantPersonId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaim_bookId_fkey') THEN
    ALTER TABLE "RightsClaim" ADD CONSTRAINT "RightsClaim_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaim_bookVersionId_fkey') THEN
    ALTER TABLE "RightsClaim" ADD CONSTRAINT "RightsClaim_bookVersionId_fkey" FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaim_rightsProfileId_fkey') THEN
    ALTER TABLE "RightsClaim" ADD CONSTRAINT "RightsClaim_rightsProfileId_fkey" FOREIGN KEY ("rightsProfileId") REFERENCES "RightsProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaim_rightsIntakeId_fkey') THEN
    ALTER TABLE "RightsClaim" ADD CONSTRAINT "RightsClaim_rightsIntakeId_fkey" FOREIGN KEY ("rightsIntakeId") REFERENCES "RightsIntake"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaim_mediaAssetId_fkey') THEN
    ALTER TABLE "RightsClaim" ADD CONSTRAINT "RightsClaim_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaim_assignedToUserId_fkey') THEN
    ALTER TABLE "RightsClaim" ADD CONSTRAINT "RightsClaim_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaim_responseByUserId_fkey') THEN
    ALTER TABLE "RightsClaim" ADD CONSTRAINT "RightsClaim_responseByUserId_fkey" FOREIGN KEY ("responseByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaim_resolvedByUserId_fkey') THEN
    ALTER TABLE "RightsClaim" ADD CONSTRAINT "RightsClaim_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaim_parentClaimId_fkey') THEN
    ALTER TABLE "RightsClaim" ADD CONSTRAINT "RightsClaim_parentClaimId_fkey" FOREIGN KEY ("parentClaimId") REFERENCES "RightsClaim"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaim_createdByUserId_fkey') THEN
    ALTER TABLE "RightsClaim" ADD CONSTRAINT "RightsClaim_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaimComponent_rightsClaimId_fkey') THEN
    ALTER TABLE "RightsClaimComponent" ADD CONSTRAINT "RightsClaimComponent_rightsClaimId_fkey" FOREIGN KEY ("rightsClaimId") REFERENCES "RightsClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaimComponent_rightsComponentId_fkey') THEN
    ALTER TABLE "RightsClaimComponent" ADD CONSTRAINT "RightsClaimComponent_rightsComponentId_fkey" FOREIGN KEY ("rightsComponentId") REFERENCES "RightsComponent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaimAccessBlock_rightsClaimId_fkey') THEN
    ALTER TABLE "RightsClaimAccessBlock" ADD CONSTRAINT "RightsClaimAccessBlock_rightsClaimId_fkey" FOREIGN KEY ("rightsClaimId") REFERENCES "RightsClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaimAccessBlock_bookId_fkey') THEN
    ALTER TABLE "RightsClaimAccessBlock" ADD CONSTRAINT "RightsClaimAccessBlock_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaimAccessBlock_bookVersionId_fkey') THEN
    ALTER TABLE "RightsClaimAccessBlock" ADD CONSTRAINT "RightsClaimAccessBlock_bookVersionId_fkey" FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaimAccessBlock_appliedByUserId_fkey') THEN
    ALTER TABLE "RightsClaimAccessBlock" ADD CONSTRAINT "RightsClaimAccessBlock_appliedByUserId_fkey" FOREIGN KEY ("appliedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaimAccessBlock_liftedByUserId_fkey') THEN
    ALTER TABLE "RightsClaimAccessBlock" ADD CONSTRAINT "RightsClaimAccessBlock_liftedByUserId_fkey" FOREIGN KEY ("liftedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaimAttachment_rightsClaimId_fkey') THEN
    ALTER TABLE "RightsClaimAttachment" ADD CONSTRAINT "RightsClaimAttachment_rightsClaimId_fkey" FOREIGN KEY ("rightsClaimId") REFERENCES "RightsClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaimAttachment_mediaAssetId_fkey') THEN
    ALTER TABLE "RightsClaimAttachment" ADD CONSTRAINT "RightsClaimAttachment_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaimAttachment_uploadedByUserId_fkey') THEN
    ALTER TABLE "RightsClaimAttachment" ADD CONSTRAINT "RightsClaimAttachment_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaimAttachment_removedByUserId_fkey') THEN
    ALTER TABLE "RightsClaimAttachment" ADD CONSTRAINT "RightsClaimAttachment_removedByUserId_fkey" FOREIGN KEY ("removedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaimEvent_rightsClaimId_fkey') THEN
    ALTER TABLE "RightsClaimEvent" ADD CONSTRAINT "RightsClaimEvent_rightsClaimId_fkey" FOREIGN KEY ("rightsClaimId") REFERENCES "RightsClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsClaimEvent_createdByUserId_fkey') THEN
    ALTER TABLE "RightsClaimEvent" ADD CONSTRAINT "RightsClaimEvent_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
