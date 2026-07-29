-- Phase 18: Automatic Recheck
-- Adds RightsLegalChangeEvent / RightsRecheckTask / RightsRecheckEvent / RightsRecheckScanRun,
-- ten enums, the review history chain on RightsReview and the recheck policy on RightsProfile.
--
-- Every statement is guarded so the migration can be safely re-applied over a partially
-- applied state (Prisma does not wrap a migration file in a single transaction).
--
-- IMPORTANT: apply 20260730000000_add_recheck_notification_types BEFORE this migration.

-- CreateEnum
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsRecheckReason') THEN
    CREATE TYPE "RightsRecheckReason" AS ENUM ('SCHEDULED_DUE', 'CONTENT_CHANGED', 'RIGHTS_DATA_CHANGED', 'LANGUAGE_ADDED', 'AUDIO_ADDED', 'COMPONENT_ADDED', 'LEGAL_CHANGE', 'REVIEW_STALE', 'MANUAL_REQUEST', 'OTHER');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsRecheckStatus') THEN
    CREATE TYPE "RightsRecheckStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'DISMISSED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsRecheckSeverity') THEN
    CREATE TYPE "RightsRecheckSeverity" AS ENUM ('INFO', 'WARNING', 'BLOCKING');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsRecheckReminderStage') THEN
    CREATE TYPE "RightsRecheckReminderStage" AS ENUM ('NONE', 'LEAD_30', 'LEAD_7', 'DUE', 'OVERDUE', 'ESCALATED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsRecheckResolution') THEN
    CREATE TYPE "RightsRecheckResolution" AS ENUM ('NEW_REVIEW_APPROVED', 'SUPERSEDED_BY_NEW_REVIEW', 'NO_CHANGE_NEEDED', 'CONTENT_REVERTED', 'MANUALLY_CLOSED', 'DISMISSED_NOT_APPLICABLE', 'OTHER');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsRecheckTriggerSource') THEN
    CREATE TYPE "RightsRecheckTriggerSource" AS ENUM ('SCHEDULER', 'CONTENT_HASH', 'VERSION_CREATED', 'LEGAL_CHANGE', 'MANUAL');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsRecheckEventType') THEN
    CREATE TYPE "RightsRecheckEventType" AS ENUM ('TASK_CREATED', 'REMINDER_SENT', 'SEVERITY_ESCALATED', 'SNOOZED', 'STARTED', 'COMPLETED', 'DISMISSED', 'REOPENED', 'DUE_DATE_CHANGED', 'LINKED_TO_REVIEW', 'NOTE_ADDED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsRecheckPolicy') THEN
    CREATE TYPE "RightsRecheckPolicy" AS ENUM ('INHERIT_REPORT', 'FIXED_INTERVAL', 'MANUAL_ONLY', 'PAUSED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsLegalChangeType') THEN
    CREATE TYPE "RightsLegalChangeType" AS ENUM ('COPYRIGHT_TERM_CHANGE', 'PUBLIC_DOMAIN_RULE_CHANGE', 'TRANSLATION_RIGHTS_CHANGE', 'NEIGHBOURING_RIGHTS_CHANGE', 'COURT_DECISION', 'TREATY_RATIFICATION', 'PLATFORM_POLICY_CHANGE', 'OTHER');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsLegalChangeStatus') THEN
    CREATE TYPE "RightsLegalChangeStatus" AS ENUM ('DRAFT', 'APPLIED', 'ARCHIVED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsRecheckScanStatus') THEN
    CREATE TYPE "RightsRecheckScanStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');
  END IF;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "RightsLegalChangeEvent" (
    "id" TEXT NOT NULL,
    "titleRu" TEXT NOT NULL,
    "descriptionRu" TEXT NOT NULL,
    "changeType" "RightsLegalChangeType" NOT NULL,
    "status" "RightsLegalChangeStatus" NOT NULL DEFAULT 'DRAFT',
    "severity" "RightsRecheckSeverity" NOT NULL DEFAULT 'WARNING',
    "jurisdictionCodes" JSONB NOT NULL,
    "appliesToAllCountries" BOOLEAN NOT NULL DEFAULT false,
    "effectiveFrom" TIMESTAMP(3),
    "sourceUrl" TEXT,
    "sourceTitle" TEXT,
    "appliedAt" TIMESTAMP(3),
    "appliedByUserId" TEXT,
    "affectedProfilesCount" INTEGER NOT NULL DEFAULT 0,
    "createdTasksCount" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RightsLegalChangeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "RightsRecheckTask" (
    "id" TEXT NOT NULL,
    "reason" "RightsRecheckReason" NOT NULL,
    "status" "RightsRecheckStatus" NOT NULL DEFAULT 'PENDING',
    "severity" "RightsRecheckSeverity" NOT NULL DEFAULT 'INFO',
    "source" "RightsRecheckTriggerSource" NOT NULL DEFAULT 'SCHEDULER',
    "rightsProfileId" TEXT,
    "rightsIntakeId" TEXT,
    "baselineReviewId" TEXT,
    "bookId" TEXT,
    "bookVersionId" TEXT,
    "legalChangeEventId" TEXT,
    "titleRu" TEXT NOT NULL,
    "descriptionRu" TEXT NOT NULL,
    "triggerCode" TEXT,
    "affectedCountryCodes" JSONB,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "reminderStage" "RightsRecheckReminderStage" NOT NULL DEFAULT 'NONE',
    "remindersSentCount" INTEGER NOT NULL DEFAULT 0,
    "lastReminderAt" TIMESTAMP(3),
    "snoozedUntil" TIMESTAMP(3),
    "snoozeReasonRu" TEXT,
    "startedAt" TIMESTAMP(3),
    "startedByUserId" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedByUserId" TEXT,
    "completionNotesRu" TEXT,
    "completedReviewId" TEXT,
    "dismissedAt" TIMESTAMP(3),
    "dismissedByUserId" TEXT,
    "dismissReasonRu" TEXT,
    "resolution" "RightsRecheckResolution",
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RightsRecheckTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "RightsRecheckEvent" (
    "id" TEXT NOT NULL,
    "recheckTaskId" TEXT NOT NULL,
    "eventType" "RightsRecheckEventType" NOT NULL,
    "fromStatus" "RightsRecheckStatus",
    "toStatus" "RightsRecheckStatus",
    "messageRu" TEXT NOT NULL,
    "payload" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RightsRecheckEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "RightsRecheckScanRun" (
    "id" TEXT NOT NULL,
    "status" "RightsRecheckScanStatus" NOT NULL DEFAULT 'RUNNING',
    "source" "RightsRecheckTriggerSource" NOT NULL DEFAULT 'SCHEDULER',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "profilesScanned" INTEGER NOT NULL DEFAULT 0,
    "versionsScanned" INTEGER NOT NULL DEFAULT 0,
    "tasksCreated" INTEGER NOT NULL DEFAULT 0,
    "tasksEscalated" INTEGER NOT NULL DEFAULT 0,
    "tasksAutoClosed" INTEGER NOT NULL DEFAULT 0,
    "remindersSent" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "triggeredByUserId" TEXT,

    CONSTRAINT "RightsRecheckScanRun_pkey" PRIMARY KEY ("id")
);

-- AlterTable: Phase 18 review history chain
ALTER TABLE "RightsReview" ADD COLUMN IF NOT EXISTS "previousReviewId" TEXT;
ALTER TABLE "RightsReview" ADD COLUMN IF NOT EXISTS "chainRootReviewId" TEXT;
ALTER TABLE "RightsReview" ADD COLUMN IF NOT EXISTS "revisionNumber" INTEGER NOT NULL DEFAULT 1;

-- AlterTable: Phase 18 recheck policy
ALTER TABLE "RightsProfile" ADD COLUMN IF NOT EXISTS "recheckPolicy" "RightsRecheckPolicy" NOT NULL DEFAULT 'INHERIT_REPORT';
ALTER TABLE "RightsProfile" ADD COLUMN IF NOT EXISTS "recheckIntervalDays" INTEGER;
ALTER TABLE "RightsProfile" ADD COLUMN IF NOT EXISTS "recheckPausedUntil" TIMESTAMP(3);
ALTER TABLE "RightsProfile" ADD COLUMN IF NOT EXISTS "recheckPauseReasonRu" TEXT;
ALTER TABLE "RightsProfile" ADD COLUMN IF NOT EXISTS "lastRecheckScanAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "RightsReview_previousReviewId_key" ON "RightsReview"("previousReviewId");
CREATE INDEX IF NOT EXISTS "RightsReview_chainRootReviewId_idx" ON "RightsReview"("chainRootReviewId");
CREATE INDEX IF NOT EXISTS "RightsReview_revisionNumber_idx" ON "RightsReview"("revisionNumber");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RightsProfile_nextReviewAt_idx" ON "RightsProfile"("nextReviewAt");
CREATE INDEX IF NOT EXISTS "RightsProfile_recheckPolicy_idx" ON "RightsProfile"("recheckPolicy");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RightsLegalChangeEvent_status_idx" ON "RightsLegalChangeEvent"("status");
CREATE INDEX IF NOT EXISTS "RightsLegalChangeEvent_changeType_idx" ON "RightsLegalChangeEvent"("changeType");
CREATE INDEX IF NOT EXISTS "RightsLegalChangeEvent_effectiveFrom_idx" ON "RightsLegalChangeEvent"("effectiveFrom");
CREATE INDEX IF NOT EXISTS "RightsLegalChangeEvent_createdAt_idx" ON "RightsLegalChangeEvent"("createdAt");
CREATE INDEX IF NOT EXISTS "RightsLegalChangeEvent_appliedByUserId_idx" ON "RightsLegalChangeEvent"("appliedByUserId");
CREATE INDEX IF NOT EXISTS "RightsLegalChangeEvent_createdByUserId_idx" ON "RightsLegalChangeEvent"("createdByUserId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RightsRecheckTask_status_idx" ON "RightsRecheckTask"("status");
CREATE INDEX IF NOT EXISTS "RightsRecheckTask_reason_idx" ON "RightsRecheckTask"("reason");
CREATE INDEX IF NOT EXISTS "RightsRecheckTask_severity_idx" ON "RightsRecheckTask"("severity");
CREATE INDEX IF NOT EXISTS "RightsRecheckTask_dueAt_idx" ON "RightsRecheckTask"("dueAt");
CREATE INDEX IF NOT EXISTS "RightsRecheckTask_rightsProfileId_status_idx" ON "RightsRecheckTask"("rightsProfileId", "status");
CREATE INDEX IF NOT EXISTS "RightsRecheckTask_rightsIntakeId_idx" ON "RightsRecheckTask"("rightsIntakeId");
CREATE INDEX IF NOT EXISTS "RightsRecheckTask_bookVersionId_status_idx" ON "RightsRecheckTask"("bookVersionId", "status");
CREATE INDEX IF NOT EXISTS "RightsRecheckTask_bookId_idx" ON "RightsRecheckTask"("bookId");
CREATE INDEX IF NOT EXISTS "RightsRecheckTask_legalChangeEventId_idx" ON "RightsRecheckTask"("legalChangeEventId");
CREATE INDEX IF NOT EXISTS "RightsRecheckTask_baselineReviewId_idx" ON "RightsRecheckTask"("baselineReviewId");
CREATE INDEX IF NOT EXISTS "RightsRecheckTask_completedReviewId_idx" ON "RightsRecheckTask"("completedReviewId");
CREATE INDEX IF NOT EXISTS "RightsRecheckTask_createdAt_idx" ON "RightsRecheckTask"("createdAt");
CREATE INDEX IF NOT EXISTS "RightsRecheckTask_startedByUserId_idx" ON "RightsRecheckTask"("startedByUserId");
CREATE INDEX IF NOT EXISTS "RightsRecheckTask_completedByUserId_idx" ON "RightsRecheckTask"("completedByUserId");
CREATE INDEX IF NOT EXISTS "RightsRecheckTask_dismissedByUserId_idx" ON "RightsRecheckTask"("dismissedByUserId");
CREATE INDEX IF NOT EXISTS "RightsRecheckTask_createdByUserId_idx" ON "RightsRecheckTask"("createdByUserId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RightsRecheckEvent_recheckTaskId_idx" ON "RightsRecheckEvent"("recheckTaskId");
CREATE INDEX IF NOT EXISTS "RightsRecheckEvent_eventType_idx" ON "RightsRecheckEvent"("eventType");
CREATE INDEX IF NOT EXISTS "RightsRecheckEvent_createdAt_idx" ON "RightsRecheckEvent"("createdAt");
CREATE INDEX IF NOT EXISTS "RightsRecheckEvent_createdByUserId_idx" ON "RightsRecheckEvent"("createdByUserId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RightsRecheckScanRun_status_idx" ON "RightsRecheckScanRun"("status");
CREATE INDEX IF NOT EXISTS "RightsRecheckScanRun_startedAt_idx" ON "RightsRecheckScanRun"("startedAt");
CREATE INDEX IF NOT EXISTS "RightsRecheckScanRun_triggeredByUserId_idx" ON "RightsRecheckScanRun"("triggeredByUserId");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsReview_previousReviewId_fkey') THEN
    ALTER TABLE "RightsReview" ADD CONSTRAINT "RightsReview_previousReviewId_fkey" FOREIGN KEY ("previousReviewId") REFERENCES "RightsReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLegalChangeEvent_appliedByUserId_fkey') THEN
    ALTER TABLE "RightsLegalChangeEvent" ADD CONSTRAINT "RightsLegalChangeEvent_appliedByUserId_fkey" FOREIGN KEY ("appliedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLegalChangeEvent_createdByUserId_fkey') THEN
    ALTER TABLE "RightsLegalChangeEvent" ADD CONSTRAINT "RightsLegalChangeEvent_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsRecheckTask_rightsProfileId_fkey') THEN
    ALTER TABLE "RightsRecheckTask" ADD CONSTRAINT "RightsRecheckTask_rightsProfileId_fkey" FOREIGN KEY ("rightsProfileId") REFERENCES "RightsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsRecheckTask_rightsIntakeId_fkey') THEN
    ALTER TABLE "RightsRecheckTask" ADD CONSTRAINT "RightsRecheckTask_rightsIntakeId_fkey" FOREIGN KEY ("rightsIntakeId") REFERENCES "RightsIntake"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsRecheckTask_baselineReviewId_fkey') THEN
    ALTER TABLE "RightsRecheckTask" ADD CONSTRAINT "RightsRecheckTask_baselineReviewId_fkey" FOREIGN KEY ("baselineReviewId") REFERENCES "RightsReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsRecheckTask_bookId_fkey') THEN
    ALTER TABLE "RightsRecheckTask" ADD CONSTRAINT "RightsRecheckTask_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsRecheckTask_bookVersionId_fkey') THEN
    ALTER TABLE "RightsRecheckTask" ADD CONSTRAINT "RightsRecheckTask_bookVersionId_fkey" FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsRecheckTask_legalChangeEventId_fkey') THEN
    ALTER TABLE "RightsRecheckTask" ADD CONSTRAINT "RightsRecheckTask_legalChangeEventId_fkey" FOREIGN KEY ("legalChangeEventId") REFERENCES "RightsLegalChangeEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsRecheckTask_completedReviewId_fkey') THEN
    ALTER TABLE "RightsRecheckTask" ADD CONSTRAINT "RightsRecheckTask_completedReviewId_fkey" FOREIGN KEY ("completedReviewId") REFERENCES "RightsReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsRecheckTask_startedByUserId_fkey') THEN
    ALTER TABLE "RightsRecheckTask" ADD CONSTRAINT "RightsRecheckTask_startedByUserId_fkey" FOREIGN KEY ("startedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsRecheckTask_completedByUserId_fkey') THEN
    ALTER TABLE "RightsRecheckTask" ADD CONSTRAINT "RightsRecheckTask_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsRecheckTask_dismissedByUserId_fkey') THEN
    ALTER TABLE "RightsRecheckTask" ADD CONSTRAINT "RightsRecheckTask_dismissedByUserId_fkey" FOREIGN KEY ("dismissedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsRecheckTask_createdByUserId_fkey') THEN
    ALTER TABLE "RightsRecheckTask" ADD CONSTRAINT "RightsRecheckTask_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsRecheckEvent_recheckTaskId_fkey') THEN
    ALTER TABLE "RightsRecheckEvent" ADD CONSTRAINT "RightsRecheckEvent_recheckTaskId_fkey" FOREIGN KEY ("recheckTaskId") REFERENCES "RightsRecheckTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsRecheckEvent_createdByUserId_fkey') THEN
    ALTER TABLE "RightsRecheckEvent" ADD CONSTRAINT "RightsRecheckEvent_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsRecheckScanRun_triggeredByUserId_fkey') THEN
    ALTER TABLE "RightsRecheckScanRun" ADD CONSTRAINT "RightsRecheckScanRun_triggeredByUserId_fkey" FOREIGN KEY ("triggeredByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Phase 18 backfill: существующие проверки получают корень цепочки, равный самим себе.
-- previousReviewId остаётся NULL: восстанавливать порядок задним числом ненадёжно,
-- а revisionNumber = 1 корректно описывает «единственную проверку в цепочке».
UPDATE "RightsReview" SET "chainRootReviewId" = "id" WHERE "chainRootReviewId" IS NULL;
