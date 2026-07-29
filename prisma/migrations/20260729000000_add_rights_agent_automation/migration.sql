-- Phase 17: Agent/API Import Automation
-- Adds RightsAgentUploadToken / RightsAgentSubmission / RightsNotification plus five enums.
--
-- Every statement is guarded so the migration can be safely re-applied over a partially
-- applied state (Prisma does not wrap a migration file in a single transaction).

-- CreateEnum
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsAgentTokenStatus') THEN
    CREATE TYPE "RightsAgentTokenStatus" AS ENUM ('ACTIVE', 'USED', 'REVOKED', 'EXPIRED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsAgentSubmissionStatus') THEN
    CREATE TYPE "RightsAgentSubmissionStatus" AS ENUM ('RECEIVED', 'VALIDATED', 'VALIDATION_FAILED', 'REJECTED', 'FAILED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsAgentSubmissionMaterialization') THEN
    CREATE TYPE "RightsAgentSubmissionMaterialization" AS ENUM ('NOT_ATTEMPTED', 'SKIPPED', 'SUCCEEDED', 'FAILED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsNotificationType') THEN
    CREATE TYPE "RightsNotificationType" AS ENUM ('AGENT_REPORT_RECEIVED', 'AGENT_REPORT_VALIDATION_FAILED', 'AGENT_REPORT_MATERIALIZED', 'AGENT_REPORT_MATERIALIZATION_FAILED', 'AGENT_TOKEN_ISSUED', 'AGENT_TOKEN_REVOKED', 'HUMAN_REVIEW_REQUIRED', 'RECHECK_DUE', 'LAWYER_REVIEW_REQUIRED', 'OTHER');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsNotificationSeverity') THEN
    CREATE TYPE "RightsNotificationSeverity" AS ENUM ('INFO', 'SUCCESS', 'WARNING', 'ERROR');
  END IF;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "RightsAgentUploadToken" (
    "id" TEXT NOT NULL,
    "rightsIntakeId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "status" "RightsAgentTokenStatus" NOT NULL DEFAULT 'ACTIVE',
    "labelRu" TEXT,
    "allowedSchemaVersions" JSONB,
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "maxFailedAttempts" INTEGER NOT NULL DEFAULT 5,
    "allowRetryOnValidationError" BOOLEAN NOT NULL DEFAULT true,
    "autoMaterialize" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "issuedByUserId" TEXT,
    "firstUsedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIp" TEXT,
    "lastUsedUserAgent" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "revokeReasonRu" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RightsAgentUploadToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "RightsAgentSubmission" (
    "id" TEXT NOT NULL,
    "rightsIntakeId" TEXT NOT NULL,
    "uploadTokenId" TEXT,
    "status" "RightsAgentSubmissionStatus" NOT NULL DEFAULT 'RECEIVED',
    "declaredSchemaVersion" TEXT,
    "reportJsonSha256" TEXT,
    "payloadSizeBytes" INTEGER,
    "sourceFileName" TEXT,
    "agentName" TEXT,
    "agentVersion" TEXT,
    "submittedIp" TEXT,
    "submittedUserAgent" TEXT,
    "rightsReviewImportId" TEXT,
    "validationErrorCount" INTEGER NOT NULL DEFAULT 0,
    "validationWarningCount" INTEGER NOT NULL DEFAULT 0,
    "rejectionCode" TEXT,
    "rejectionMessageRu" TEXT,
    "materialization" "RightsAgentSubmissionMaterialization" NOT NULL DEFAULT 'NOT_ATTEMPTED',
    "materializationError" TEXT,
    "materializedProfileId" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RightsAgentSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "RightsNotification" (
    "id" TEXT NOT NULL,
    "type" "RightsNotificationType" NOT NULL,
    "severity" "RightsNotificationSeverity" NOT NULL DEFAULT 'INFO',
    "titleRu" TEXT NOT NULL,
    "messageRu" TEXT NOT NULL,
    "targetUserId" TEXT,
    "rightsIntakeId" TEXT,
    "agentSubmissionId" TEXT,
    "rightsReviewImportId" TEXT,
    "rightsProfileId" TEXT,
    "bookVersionId" TEXT,
    "payload" JSONB,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "readByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RightsNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "RightsAgentUploadToken_tokenHash_key" ON "RightsAgentUploadToken"("tokenHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RightsAgentUploadToken_rightsIntakeId_idx" ON "RightsAgentUploadToken"("rightsIntakeId");
CREATE INDEX IF NOT EXISTS "RightsAgentUploadToken_status_idx" ON "RightsAgentUploadToken"("status");
CREATE INDEX IF NOT EXISTS "RightsAgentUploadToken_expiresAt_idx" ON "RightsAgentUploadToken"("expiresAt");
CREATE INDEX IF NOT EXISTS "RightsAgentUploadToken_issuedByUserId_idx" ON "RightsAgentUploadToken"("issuedByUserId");
CREATE INDEX IF NOT EXISTS "RightsAgentUploadToken_revokedByUserId_idx" ON "RightsAgentUploadToken"("revokedByUserId");
CREATE INDEX IF NOT EXISTS "RightsAgentUploadToken_createdAt_idx" ON "RightsAgentUploadToken"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RightsAgentSubmission_rightsIntakeId_idx" ON "RightsAgentSubmission"("rightsIntakeId");
CREATE INDEX IF NOT EXISTS "RightsAgentSubmission_uploadTokenId_idx" ON "RightsAgentSubmission"("uploadTokenId");
CREATE INDEX IF NOT EXISTS "RightsAgentSubmission_status_idx" ON "RightsAgentSubmission"("status");
CREATE INDEX IF NOT EXISTS "RightsAgentSubmission_rightsReviewImportId_idx" ON "RightsAgentSubmission"("rightsReviewImportId");
CREATE INDEX IF NOT EXISTS "RightsAgentSubmission_reportJsonSha256_idx" ON "RightsAgentSubmission"("reportJsonSha256");
CREATE INDEX IF NOT EXISTS "RightsAgentSubmission_createdAt_idx" ON "RightsAgentSubmission"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RightsNotification_type_idx" ON "RightsNotification"("type");
CREATE INDEX IF NOT EXISTS "RightsNotification_severity_idx" ON "RightsNotification"("severity");
CREATE INDEX IF NOT EXISTS "RightsNotification_targetUserId_isRead_idx" ON "RightsNotification"("targetUserId", "isRead");
CREATE INDEX IF NOT EXISTS "RightsNotification_isRead_idx" ON "RightsNotification"("isRead");
CREATE INDEX IF NOT EXISTS "RightsNotification_rightsIntakeId_idx" ON "RightsNotification"("rightsIntakeId");
CREATE INDEX IF NOT EXISTS "RightsNotification_agentSubmissionId_idx" ON "RightsNotification"("agentSubmissionId");
CREATE INDEX IF NOT EXISTS "RightsNotification_createdAt_idx" ON "RightsNotification"("createdAt");
CREATE INDEX IF NOT EXISTS "RightsNotification_readByUserId_idx" ON "RightsNotification"("readByUserId");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsAgentUploadToken_rightsIntakeId_fkey') THEN
    ALTER TABLE "RightsAgentUploadToken" ADD CONSTRAINT "RightsAgentUploadToken_rightsIntakeId_fkey" FOREIGN KEY ("rightsIntakeId") REFERENCES "RightsIntake"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsAgentUploadToken_issuedByUserId_fkey') THEN
    ALTER TABLE "RightsAgentUploadToken" ADD CONSTRAINT "RightsAgentUploadToken_issuedByUserId_fkey" FOREIGN KEY ("issuedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsAgentUploadToken_revokedByUserId_fkey') THEN
    ALTER TABLE "RightsAgentUploadToken" ADD CONSTRAINT "RightsAgentUploadToken_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsAgentSubmission_rightsIntakeId_fkey') THEN
    ALTER TABLE "RightsAgentSubmission" ADD CONSTRAINT "RightsAgentSubmission_rightsIntakeId_fkey" FOREIGN KEY ("rightsIntakeId") REFERENCES "RightsIntake"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsAgentSubmission_uploadTokenId_fkey') THEN
    ALTER TABLE "RightsAgentSubmission" ADD CONSTRAINT "RightsAgentSubmission_uploadTokenId_fkey" FOREIGN KEY ("uploadTokenId") REFERENCES "RightsAgentUploadToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsAgentSubmission_rightsReviewImportId_fkey') THEN
    ALTER TABLE "RightsAgentSubmission" ADD CONSTRAINT "RightsAgentSubmission_rightsReviewImportId_fkey" FOREIGN KEY ("rightsReviewImportId") REFERENCES "RightsReviewImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsNotification_targetUserId_fkey') THEN
    ALTER TABLE "RightsNotification" ADD CONSTRAINT "RightsNotification_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsNotification_rightsIntakeId_fkey') THEN
    ALTER TABLE "RightsNotification" ADD CONSTRAINT "RightsNotification_rightsIntakeId_fkey" FOREIGN KEY ("rightsIntakeId") REFERENCES "RightsIntake"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsNotification_agentSubmissionId_fkey') THEN
    ALTER TABLE "RightsNotification" ADD CONSTRAINT "RightsNotification_agentSubmissionId_fkey" FOREIGN KEY ("agentSubmissionId") REFERENCES "RightsAgentSubmission"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsNotification_readByUserId_fkey') THEN
    ALTER TABLE "RightsNotification" ADD CONSTRAINT "RightsNotification_readByUserId_fkey" FOREIGN KEY ("readByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
