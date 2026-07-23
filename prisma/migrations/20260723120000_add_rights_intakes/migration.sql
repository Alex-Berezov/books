-- ============================================================
-- Migration: add_rights_intakes
-- Date: 2026-07-23
-- Purpose:
--   1. Create RightsIntakeStatus enum
--   2. Create RightsSourceProvider enum
--   3. Create RightsSourceTextType enum
--   4. Create RightsIntake model
-- ============================================================

CREATE TYPE "RightsIntakeStatus" AS ENUM (
  'DRAFT',
  'READY_FOR_AGENT',
  'REVIEW_IMPORTED',
  'HUMAN_REVIEW_REQUIRED',
  'APPROVED',
  'REJECTED',
  'BOOK_CREATED',
  'ARCHIVED'
);

CREATE TYPE "RightsSourceProvider" AS ENUM (
  'PROJECT_GUTENBERG',
  'OTHER',
  'UNKNOWN'
);

CREATE TYPE "RightsSourceTextType" AS ENUM (
  'ORIGINAL_TEXT',
  'TRANSLATION',
  'ADAPTATION',
  'ABRIDGMENT',
  'COMPILATION',
  'UNKNOWN'
);

CREATE TABLE "RightsIntake" (
  "id"                TEXT NOT NULL,
  "candidateTitle"    TEXT NOT NULL,
  "candidateAuthor"   TEXT NOT NULL,
  "originalTitle"     TEXT,
  "originalLanguage"  TEXT,
  "authorBirthYear"   INTEGER,
  "authorDeathYear"   INTEGER,
  "sourceProvider"    "RightsSourceProvider" NOT NULL DEFAULT 'UNKNOWN',
  "sourceExternalId"  TEXT,
  "sourceUrl"         TEXT,
  "sourceTitle"       TEXT,
  "sourceLanguage"    TEXT,
  "sourceTextType"    "RightsSourceTextType" NOT NULL DEFAULT 'UNKNOWN',
  "targetLanguages"   JSONB NOT NULL,
  "targetCountryCodes" JSONB NOT NULL,
  "plannedContentTypes" JSONB NOT NULL,
  "plannedComponents" JSONB,
  "notesRu"           TEXT,
  "workflowStatus"    "RightsIntakeStatus" NOT NULL DEFAULT 'DRAFT',
  "createdByUserId"   TEXT,
  "approvedReviewId"  TEXT,
  "createdBookId"     TEXT,
  "archivedAt"        TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,

  CONSTRAINT "RightsIntake_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RightsIntake_workflowStatus_idx" ON "RightsIntake"("workflowStatus");
CREATE INDEX "RightsIntake_createdAt_idx" ON "RightsIntake"("createdAt");
CREATE INDEX "RightsIntake_createdByUserId_idx" ON "RightsIntake"("createdByUserId");

ALTER TABLE "RightsIntake" ADD CONSTRAINT "RightsIntake_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL;
