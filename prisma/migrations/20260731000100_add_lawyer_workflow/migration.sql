-- Phase 19: Lawyer Workflow
-- Добавляет RightsLawyer / RightsLawyerReview / RightsLegalOpinion /
-- RightsLawyerReviewCondition / RightsLawyerReviewEvent, восемь новых enum'ов,
-- снимок оценки риска и юридического утверждения на RightsProfile и RightsReview,
-- а также строку роли `lawyer` в справочнике Role.
--
-- Каждый оператор защищён guard'ом, чтобы миграцию можно было безопасно повторить
-- поверх частично применённого состояния (Prisma не оборачивает файл миграции
-- в одну транзакцию).
--
-- IMPORTANT: применять ПОСЛЕ 20260731000000_add_lawyer_enum_values.

-- CreateEnum
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsRiskLevel') THEN
    CREATE TYPE "RightsRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsLawyerType') THEN
    CREATE TYPE "RightsLawyerType" AS ENUM ('IN_HOUSE', 'EXTERNAL_COUNSEL', 'LAW_FIRM', 'OTHER');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsLawyerReviewStatus') THEN
    CREATE TYPE "RightsLawyerReviewStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'APPROVED', 'APPROVED_WITH_CONDITIONS', 'REJECTED', 'WITHDRAWN', 'EXPIRED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsLawyerDecision') THEN
    CREATE TYPE "RightsLawyerDecision" AS ENUM ('APPROVED', 'APPROVED_WITH_CONDITIONS', 'REJECTED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsLawyerReviewTrigger') THEN
    CREATE TYPE "RightsLawyerReviewTrigger" AS ENUM ('AGENT_REQUESTED', 'HIGH_RISK_POLICY', 'MANUAL_REQUEST', 'RIGHTS_CLAIM', 'LEGAL_CHANGE', 'LICENSE_REQUIRED', 'OTHER');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsLegalOpinionKind') THEN
    CREATE TYPE "RightsLegalOpinionKind" AS ENUM ('EXTERNAL_COUNSEL_MEMO', 'IN_HOUSE_MEMO', 'EMAIL_CONFIRMATION', 'COURT_FILING', 'REGULATOR_RESPONSE', 'OTHER');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsLawyerConditionStatus') THEN
    CREATE TYPE "RightsLawyerConditionStatus" AS ENUM ('PENDING', 'SATISFIED', 'WAIVED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsLawyerReviewEventType') THEN
    CREATE TYPE "RightsLawyerReviewEventType" AS ENUM ('REQUESTED', 'ASSIGNED', 'UNASSIGNED', 'STARTED', 'OPINION_ATTACHED', 'OPINION_ARCHIVED', 'CONDITION_ADDED', 'CONDITION_SATISFIED', 'CONDITION_WAIVED', 'DECIDED', 'WITHDRAWN', 'REOPENED', 'EXPIRED', 'DUE_DATE_CHANGED', 'NOTE_ADDED');
  END IF;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "RightsLawyer" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "lawyerType" "RightsLawyerType" NOT NULL DEFAULT 'EXTERNAL_COUNSEL',
    "organization" TEXT,
    "barId" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "jurisdictionCodes" JSONB NOT NULL,
    "specializationRu" TEXT,
    "notesRu" TEXT,
    "userId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deactivatedAt" TIMESTAMP(3),
    "deactivatedByUserId" TEXT,
    "deactivateReasonRu" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RightsLawyer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "RightsLawyerReview" (
    "id" TEXT NOT NULL,
    "reviewNumber" TEXT NOT NULL,
    "status" "RightsLawyerReviewStatus" NOT NULL DEFAULT 'PENDING',
    "trigger" "RightsLawyerReviewTrigger" NOT NULL,
    "riskLevel" "RightsRiskLevel" NOT NULL DEFAULT 'HIGH',
    "riskFactors" JSONB,
    "rightsProfileId" TEXT,
    "rightsIntakeId" TEXT,
    "rightsReviewId" TEXT,
    "bookId" TEXT,
    "bookVersionId" TEXT,
    "rightsClaimId" TEXT,
    "titleRu" TEXT NOT NULL,
    "questionRu" TEXT NOT NULL,
    "contextRu" TEXT,
    "affectedCountryCodes" JSONB NOT NULL,
    "affectedLanguages" JSONB NOT NULL,
    "affectedComponentIds" JSONB,
    "blocksApproval" BOOLEAN NOT NULL DEFAULT true,
    "requestedByUserId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3),
    "assignedLawyerId" TEXT,
    "assignedAt" TIMESTAMP(3),
    "assignedByUserId" TEXT,
    "startedAt" TIMESTAMP(3),
    "decision" "RightsLawyerDecision",
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "decidedLawyerId" TEXT,
    "lawyerNameSnapshot" TEXT,
    "opinionSummaryRu" TEXT,
    "restrictionsRu" TEXT,
    "approvedCountryCodes" JSONB,
    "blockedCountryCodes" JSONB,
    "validUntil" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "expiryNotifiedAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnByUserId" TEXT,
    "withdrawReasonRu" TEXT,
    "reopenedAt" TIMESTAMP(3),
    "reopenedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RightsLawyerReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "RightsLegalOpinion" (
    "id" TEXT NOT NULL,
    "rightsLawyerReviewId" TEXT NOT NULL,
    "kind" "RightsLegalOpinionKind" NOT NULL DEFAULT 'EXTERNAL_COUNSEL_MEMO',
    "titleRu" TEXT NOT NULL,
    "bodyRu" TEXT NOT NULL,
    "lawyerId" TEXT,
    "lawyerNameSnapshot" TEXT,
    "documentUrl" TEXT,
    "documentSha256" TEXT,
    "fileName" TEXT,
    "mimeType" TEXT,
    "issuedAt" TIMESTAMP(3),
    "jurisdictionCodes" JSONB,
    "rightsEvidenceId" TEXT,
    "uploadedByUserId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "archivedByUserId" TEXT,
    "archiveReasonRu" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RightsLegalOpinion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "RightsLawyerReviewCondition" (
    "id" TEXT NOT NULL,
    "rightsLawyerReviewId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "textRu" TEXT NOT NULL,
    "status" "RightsLawyerConditionStatus" NOT NULL DEFAULT 'PENDING',
    "isBlocking" BOOLEAN NOT NULL DEFAULT true,
    "affectedCountryCodes" JSONB,
    "satisfiedAt" TIMESTAMP(3),
    "satisfiedByUserId" TEXT,
    "satisfiedNotesRu" TEXT,
    "waivedAt" TIMESTAMP(3),
    "waivedByUserId" TEXT,
    "waiveReasonRu" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RightsLawyerReviewCondition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "RightsLawyerReviewEvent" (
    "id" TEXT NOT NULL,
    "rightsLawyerReviewId" TEXT NOT NULL,
    "eventType" "RightsLawyerReviewEventType" NOT NULL,
    "fromStatus" "RightsLawyerReviewStatus",
    "toStatus" "RightsLawyerReviewStatus",
    "messageRu" TEXT NOT NULL,
    "payload" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RightsLawyerReviewEvent_pkey" PRIMARY KEY ("id")
);

-- AlterTable: Phase 19 snapshot on RightsProfile
ALTER TABLE "RightsProfile" ADD COLUMN IF NOT EXISTS "riskLevel" "RightsRiskLevel" NOT NULL DEFAULT 'LOW';
ALTER TABLE "RightsProfile" ADD COLUMN IF NOT EXISTS "riskFactors" JSONB;
ALTER TABLE "RightsProfile" ADD COLUMN IF NOT EXISTS "riskAssessedAt" TIMESTAMP(3);
ALTER TABLE "RightsProfile" ADD COLUMN IF NOT EXISTS "lawyerReviewRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RightsProfile" ADD COLUMN IF NOT EXISTS "lawyerReviewBlocking" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RightsProfile" ADD COLUMN IF NOT EXISTS "currentLawyerReviewId" TEXT;
ALTER TABLE "RightsProfile" ADD COLUMN IF NOT EXISTS "lawyerApprovedAt" TIMESTAMP(3);
ALTER TABLE "RightsProfile" ADD COLUMN IF NOT EXISTS "lawyerApprovedLawyerId" TEXT;
ALTER TABLE "RightsProfile" ADD COLUMN IF NOT EXISTS "lawyerApprovedLawyerName" TEXT;
ALTER TABLE "RightsProfile" ADD COLUMN IF NOT EXISTS "lawyerOpinionValidUntil" TIMESTAMP(3);

-- AlterTable: Phase 19 snapshot on RightsReview
ALTER TABLE "RightsReview" ADD COLUMN IF NOT EXISTS "lawyerReviewRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RightsReview" ADD COLUMN IF NOT EXISTS "lawyerReviewId" TEXT;
ALTER TABLE "RightsReview" ADD COLUMN IF NOT EXISTS "lawyerApprovedAt" TIMESTAMP(3);
ALTER TABLE "RightsReview" ADD COLUMN IF NOT EXISTS "lawyerNameSnapshot" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "RightsLawyer_userId_key" ON "RightsLawyer"("userId");
CREATE INDEX IF NOT EXISTS "RightsLawyer_isActive_idx" ON "RightsLawyer"("isActive");
CREATE INDEX IF NOT EXISTS "RightsLawyer_lawyerType_idx" ON "RightsLawyer"("lawyerType");
CREATE INDEX IF NOT EXISTS "RightsLawyer_fullName_idx" ON "RightsLawyer"("fullName");
CREATE INDEX IF NOT EXISTS "RightsLawyer_userId_idx" ON "RightsLawyer"("userId");
CREATE INDEX IF NOT EXISTS "RightsLawyer_createdByUserId_idx" ON "RightsLawyer"("createdByUserId");

CREATE UNIQUE INDEX IF NOT EXISTS "RightsLawyerReview_reviewNumber_key" ON "RightsLawyerReview"("reviewNumber");
CREATE INDEX IF NOT EXISTS "RightsLawyerReview_status_idx" ON "RightsLawyerReview"("status");
CREATE INDEX IF NOT EXISTS "RightsLawyerReview_trigger_idx" ON "RightsLawyerReview"("trigger");
CREATE INDEX IF NOT EXISTS "RightsLawyerReview_riskLevel_idx" ON "RightsLawyerReview"("riskLevel");
CREATE INDEX IF NOT EXISTS "RightsLawyerReview_decision_idx" ON "RightsLawyerReview"("decision");
CREATE INDEX IF NOT EXISTS "RightsLawyerReview_rightsProfileId_idx" ON "RightsLawyerReview"("rightsProfileId");
CREATE INDEX IF NOT EXISTS "RightsLawyerReview_rightsIntakeId_idx" ON "RightsLawyerReview"("rightsIntakeId");
CREATE INDEX IF NOT EXISTS "RightsLawyerReview_rightsReviewId_idx" ON "RightsLawyerReview"("rightsReviewId");
CREATE INDEX IF NOT EXISTS "RightsLawyerReview_bookId_idx" ON "RightsLawyerReview"("bookId");
CREATE INDEX IF NOT EXISTS "RightsLawyerReview_bookVersionId_idx" ON "RightsLawyerReview"("bookVersionId");
CREATE INDEX IF NOT EXISTS "RightsLawyerReview_rightsClaimId_idx" ON "RightsLawyerReview"("rightsClaimId");
CREATE INDEX IF NOT EXISTS "RightsLawyerReview_assignedLawyerId_idx" ON "RightsLawyerReview"("assignedLawyerId");
CREATE INDEX IF NOT EXISTS "RightsLawyerReview_dueAt_idx" ON "RightsLawyerReview"("dueAt");
CREATE INDEX IF NOT EXISTS "RightsLawyerReview_validUntil_idx" ON "RightsLawyerReview"("validUntil");
CREATE INDEX IF NOT EXISTS "RightsLawyerReview_blocksApproval_idx" ON "RightsLawyerReview"("blocksApproval");
CREATE INDEX IF NOT EXISTS "RightsLawyerReview_createdAt_idx" ON "RightsLawyerReview"("createdAt");
CREATE INDEX IF NOT EXISTS "RightsLawyerReview_requestedByUserId_idx" ON "RightsLawyerReview"("requestedByUserId");
CREATE INDEX IF NOT EXISTS "RightsLawyerReview_assignedByUserId_idx" ON "RightsLawyerReview"("assignedByUserId");
CREATE INDEX IF NOT EXISTS "RightsLawyerReview_decidedByUserId_idx" ON "RightsLawyerReview"("decidedByUserId");
CREATE INDEX IF NOT EXISTS "RightsLawyerReview_withdrawnByUserId_idx" ON "RightsLawyerReview"("withdrawnByUserId");
CREATE INDEX IF NOT EXISTS "RightsLawyerReview_reopenedByUserId_idx" ON "RightsLawyerReview"("reopenedByUserId");

CREATE UNIQUE INDEX IF NOT EXISTS "RightsLegalOpinion_rightsEvidenceId_key" ON "RightsLegalOpinion"("rightsEvidenceId");
CREATE INDEX IF NOT EXISTS "RightsLegalOpinion_rightsLawyerReviewId_idx" ON "RightsLegalOpinion"("rightsLawyerReviewId");
CREATE INDEX IF NOT EXISTS "RightsLegalOpinion_kind_idx" ON "RightsLegalOpinion"("kind");
CREATE INDEX IF NOT EXISTS "RightsLegalOpinion_lawyerId_idx" ON "RightsLegalOpinion"("lawyerId");
CREATE INDEX IF NOT EXISTS "RightsLegalOpinion_documentSha256_idx" ON "RightsLegalOpinion"("documentSha256");
CREATE INDEX IF NOT EXISTS "RightsLegalOpinion_archivedAt_idx" ON "RightsLegalOpinion"("archivedAt");
CREATE INDEX IF NOT EXISTS "RightsLegalOpinion_uploadedByUserId_idx" ON "RightsLegalOpinion"("uploadedByUserId");
CREATE INDEX IF NOT EXISTS "RightsLegalOpinion_archivedByUserId_idx" ON "RightsLegalOpinion"("archivedByUserId");

CREATE INDEX IF NOT EXISTS "RightsLawyerReviewCondition_rightsLawyerReviewId_idx" ON "RightsLawyerReviewCondition"("rightsLawyerReviewId");
CREATE INDEX IF NOT EXISTS "RightsLawyerReviewCondition_status_idx" ON "RightsLawyerReviewCondition"("status");
CREATE INDEX IF NOT EXISTS "RightsLawyerReviewCondition_isBlocking_idx" ON "RightsLawyerReviewCondition"("isBlocking");
CREATE INDEX IF NOT EXISTS "RightsLawyerReviewCondition_satisfiedByUserId_idx" ON "RightsLawyerReviewCondition"("satisfiedByUserId");
CREATE INDEX IF NOT EXISTS "RightsLawyerReviewCondition_waivedByUserId_idx" ON "RightsLawyerReviewCondition"("waivedByUserId");

CREATE INDEX IF NOT EXISTS "RightsLawyerReviewEvent_rightsLawyerReviewId_idx" ON "RightsLawyerReviewEvent"("rightsLawyerReviewId");
CREATE INDEX IF NOT EXISTS "RightsLawyerReviewEvent_eventType_idx" ON "RightsLawyerReviewEvent"("eventType");
CREATE INDEX IF NOT EXISTS "RightsLawyerReviewEvent_createdAt_idx" ON "RightsLawyerReviewEvent"("createdAt");
CREATE INDEX IF NOT EXISTS "RightsLawyerReviewEvent_createdByUserId_idx" ON "RightsLawyerReviewEvent"("createdByUserId");

CREATE INDEX IF NOT EXISTS "RightsProfile_riskLevel_idx" ON "RightsProfile"("riskLevel");
CREATE INDEX IF NOT EXISTS "RightsProfile_lawyerReviewRequired_idx" ON "RightsProfile"("lawyerReviewRequired");
CREATE INDEX IF NOT EXISTS "RightsProfile_lawyerReviewBlocking_idx" ON "RightsProfile"("lawyerReviewBlocking");
CREATE INDEX IF NOT EXISTS "RightsProfile_lawyerApprovedAt_idx" ON "RightsProfile"("lawyerApprovedAt");

CREATE INDEX IF NOT EXISTS "RightsReview_lawyerReviewId_idx" ON "RightsReview"("lawyerReviewId");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLawyer_userId_fkey') THEN
    ALTER TABLE "RightsLawyer" ADD CONSTRAINT "RightsLawyer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLawyer_deactivatedByUserId_fkey') THEN
    ALTER TABLE "RightsLawyer" ADD CONSTRAINT "RightsLawyer_deactivatedByUserId_fkey" FOREIGN KEY ("deactivatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLawyer_createdByUserId_fkey') THEN
    ALTER TABLE "RightsLawyer" ADD CONSTRAINT "RightsLawyer_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLawyerReview_rightsProfileId_fkey') THEN
    ALTER TABLE "RightsLawyerReview" ADD CONSTRAINT "RightsLawyerReview_rightsProfileId_fkey" FOREIGN KEY ("rightsProfileId") REFERENCES "RightsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLawyerReview_rightsIntakeId_fkey') THEN
    ALTER TABLE "RightsLawyerReview" ADD CONSTRAINT "RightsLawyerReview_rightsIntakeId_fkey" FOREIGN KEY ("rightsIntakeId") REFERENCES "RightsIntake"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLawyerReview_rightsReviewId_fkey') THEN
    ALTER TABLE "RightsLawyerReview" ADD CONSTRAINT "RightsLawyerReview_rightsReviewId_fkey" FOREIGN KEY ("rightsReviewId") REFERENCES "RightsReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLawyerReview_bookId_fkey') THEN
    ALTER TABLE "RightsLawyerReview" ADD CONSTRAINT "RightsLawyerReview_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLawyerReview_bookVersionId_fkey') THEN
    ALTER TABLE "RightsLawyerReview" ADD CONSTRAINT "RightsLawyerReview_bookVersionId_fkey" FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLawyerReview_assignedLawyerId_fkey') THEN
    ALTER TABLE "RightsLawyerReview" ADD CONSTRAINT "RightsLawyerReview_assignedLawyerId_fkey" FOREIGN KEY ("assignedLawyerId") REFERENCES "RightsLawyer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLawyerReview_requestedByUserId_fkey') THEN
    ALTER TABLE "RightsLawyerReview" ADD CONSTRAINT "RightsLawyerReview_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLawyerReview_assignedByUserId_fkey') THEN
    ALTER TABLE "RightsLawyerReview" ADD CONSTRAINT "RightsLawyerReview_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLawyerReview_decidedByUserId_fkey') THEN
    ALTER TABLE "RightsLawyerReview" ADD CONSTRAINT "RightsLawyerReview_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLawyerReview_withdrawnByUserId_fkey') THEN
    ALTER TABLE "RightsLawyerReview" ADD CONSTRAINT "RightsLawyerReview_withdrawnByUserId_fkey" FOREIGN KEY ("withdrawnByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLawyerReview_reopenedByUserId_fkey') THEN
    ALTER TABLE "RightsLawyerReview" ADD CONSTRAINT "RightsLawyerReview_reopenedByUserId_fkey" FOREIGN KEY ("reopenedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLegalOpinion_rightsLawyerReviewId_fkey') THEN
    ALTER TABLE "RightsLegalOpinion" ADD CONSTRAINT "RightsLegalOpinion_rightsLawyerReviewId_fkey" FOREIGN KEY ("rightsLawyerReviewId") REFERENCES "RightsLawyerReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLegalOpinion_lawyerId_fkey') THEN
    ALTER TABLE "RightsLegalOpinion" ADD CONSTRAINT "RightsLegalOpinion_lawyerId_fkey" FOREIGN KEY ("lawyerId") REFERENCES "RightsLawyer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLegalOpinion_rightsEvidenceId_fkey') THEN
    ALTER TABLE "RightsLegalOpinion" ADD CONSTRAINT "RightsLegalOpinion_rightsEvidenceId_fkey" FOREIGN KEY ("rightsEvidenceId") REFERENCES "RightsEvidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLegalOpinion_uploadedByUserId_fkey') THEN
    ALTER TABLE "RightsLegalOpinion" ADD CONSTRAINT "RightsLegalOpinion_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLegalOpinion_archivedByUserId_fkey') THEN
    ALTER TABLE "RightsLegalOpinion" ADD CONSTRAINT "RightsLegalOpinion_archivedByUserId_fkey" FOREIGN KEY ("archivedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLawyerReviewCondition_rightsLawyerReviewId_fkey') THEN
    ALTER TABLE "RightsLawyerReviewCondition" ADD CONSTRAINT "RightsLawyerReviewCondition_rightsLawyerReviewId_fkey" FOREIGN KEY ("rightsLawyerReviewId") REFERENCES "RightsLawyerReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLawyerReviewCondition_satisfiedByUserId_fkey') THEN
    ALTER TABLE "RightsLawyerReviewCondition" ADD CONSTRAINT "RightsLawyerReviewCondition_satisfiedByUserId_fkey" FOREIGN KEY ("satisfiedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLawyerReviewCondition_waivedByUserId_fkey') THEN
    ALTER TABLE "RightsLawyerReviewCondition" ADD CONSTRAINT "RightsLawyerReviewCondition_waivedByUserId_fkey" FOREIGN KEY ("waivedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLawyerReviewEvent_rightsLawyerReviewId_fkey') THEN
    ALTER TABLE "RightsLawyerReviewEvent" ADD CONSTRAINT "RightsLawyerReviewEvent_rightsLawyerReviewId_fkey" FOREIGN KEY ("rightsLawyerReviewId") REFERENCES "RightsLawyerReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsLawyerReviewEvent_createdByUserId_fkey') THEN
    ALTER TABLE "RightsLawyerReviewEvent" ADD CONSTRAINT "RightsLawyerReviewEvent_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Роль юриста должна существовать в справочнике Role, иначе RolesGuard её никогда не найдёт.
INSERT INTO "Role" ("name") VALUES ('lawyer') ON CONFLICT ("name") DO NOTHING;
