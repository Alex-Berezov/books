-- Phase 8: Content Hash & Stale Detection

-- BookVersion content hash fields
ALTER TABLE "BookVersion" ADD COLUMN "rightsContentHash" TEXT;
ALTER TABLE "BookVersion" ADD COLUMN "rightsContentHashAlgorithmVersion" TEXT;
ALTER TABLE "BookVersion" ADD COLUMN "rightsContentHashInput" JSONB;
ALTER TABLE "BookVersion" ADD COLUMN "rightsContentHashCalculatedAt" TIMESTAMP(3);
ALTER TABLE "BookVersion" ADD COLUMN "rightsRecheckRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BookVersion" ADD COLUMN "rightsStaleDetectedAt" TIMESTAMP(3);
ALTER TABLE "BookVersion" ADD COLUMN "rightsStaleReasonCode" TEXT;
ALTER TABLE "BookVersion" ADD COLUMN "rightsStaleReasonRu" TEXT;

-- BookVersion indexes
CREATE INDEX IF NOT EXISTS "BookVersion_rightsContentHash_idx" ON "BookVersion"("rightsContentHash");
CREATE INDEX IF NOT EXISTS "BookVersion_rightsRecheckRequired_idx" ON "BookVersion"("rightsRecheckRequired");
CREATE INDEX IF NOT EXISTS "BookVersion_rightsStaleDetectedAt_idx" ON "BookVersion"("rightsStaleDetectedAt");

-- RightsReview content hash fields
ALTER TABLE "RightsReview" ADD COLUMN "contentHash" TEXT;
ALTER TABLE "RightsReview" ADD COLUMN "contentHashAlgorithmVersion" TEXT;
ALTER TABLE "RightsReview" ADD COLUMN "contentHashInput" JSONB;
ALTER TABLE "RightsReview" ADD COLUMN "contentHashCalculatedAt" TIMESTAMP(3);
ALTER TABLE "RightsReview" ADD COLUMN "staleDetectedAt" TIMESTAMP(3);
ALTER TABLE "RightsReview" ADD COLUMN "staleReasonCode" TEXT;
ALTER TABLE "RightsReview" ADD COLUMN "staleReasonRu" TEXT;

-- RightsReview indexes
CREATE INDEX IF NOT EXISTS "RightsReview_contentHash_idx" ON "RightsReview"("contentHash");
CREATE INDEX IF NOT EXISTS "RightsReview_staleDetectedAt_idx" ON "RightsReview"("staleDetectedAt");

-- RightsProfile content hash fields
ALTER TABLE "RightsProfile" ADD COLUMN "contentHash" TEXT;
ALTER TABLE "RightsProfile" ADD COLUMN "contentHashAlgorithmVersion" TEXT;
ALTER TABLE "RightsProfile" ADD COLUMN "contentHashInput" JSONB;
ALTER TABLE "RightsProfile" ADD COLUMN "contentHashCalculatedAt" TIMESTAMP(3);
ALTER TABLE "RightsProfile" ADD COLUMN "staleDetectedAt" TIMESTAMP(3);
ALTER TABLE "RightsProfile" ADD COLUMN "staleReasonCode" TEXT;
ALTER TABLE "RightsProfile" ADD COLUMN "staleReasonRu" TEXT;

-- RightsProfile indexes
CREATE INDEX IF NOT EXISTS "RightsProfile_contentHash_idx" ON "RightsProfile"("contentHash");
CREATE INDEX IF NOT EXISTS "RightsProfile_staleDetectedAt_idx" ON "RightsProfile"("staleDetectedAt");

-- RightsContentChangeTrigger enum
DO $$ BEGIN
  CREATE TYPE "RightsContentChangeTrigger" AS ENUM (
    'INITIAL_VERSION_SNAPSHOT',
    'BOOK_VERSION_UPDATED',
    'CHAPTER_CREATED',
    'CHAPTER_UPDATED',
    'CHAPTER_DELETED',
    'AUDIO_CHAPTER_CREATED',
    'AUDIO_CHAPTER_UPDATED',
    'AUDIO_CHAPTER_DELETED',
    'AUDIO_CHAPTER_REORDERED',
    'RIGHTS_SNAPSHOT_CHANGED',
    'SOURCE_EDITION_CHANGED',
    'REVIEW_IMPORT_CHANGED',
    'MANUAL_HASH_CHECK'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- RightsContentHashEvent audit model
CREATE TABLE IF NOT EXISTS "RightsContentHashEvent" (
  "id" TEXT NOT NULL,
  "bookVersionId" TEXT,
  "rightsProfileId" TEXT,
  "rightsReviewId" TEXT,
  "trigger" "RightsContentChangeTrigger" NOT NULL,
  "previousHash" TEXT,
  "currentHash" TEXT,
  "hashAlgorithmVersion" TEXT NOT NULL,
  "staleMarked" BOOLEAN NOT NULL DEFAULT false,
  "reasonCode" TEXT,
  "reasonRu" TEXT,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RightsContentHashEvent_pkey" PRIMARY KEY ("id")
);

-- RightsContentHashEvent indexes
CREATE INDEX IF NOT EXISTS "RightsContentHashEvent_bookVersionId_idx" ON "RightsContentHashEvent"("bookVersionId");
CREATE INDEX IF NOT EXISTS "RightsContentHashEvent_rightsProfileId_idx" ON "RightsContentHashEvent"("rightsProfileId");
CREATE INDEX IF NOT EXISTS "RightsContentHashEvent_rightsReviewId_idx" ON "RightsContentHashEvent"("rightsReviewId");
CREATE INDEX IF NOT EXISTS "RightsContentHashEvent_trigger_idx" ON "RightsContentHashEvent"("trigger");
CREATE INDEX IF NOT EXISTS "RightsContentHashEvent_staleMarked_idx" ON "RightsContentHashEvent"("staleMarked");
CREATE INDEX IF NOT EXISTS "RightsContentHashEvent_createdAt_idx" ON "RightsContentHashEvent"("createdAt");

-- RightsContentHashEvent foreign keys
ALTER TABLE "RightsContentHashEvent" ADD CONSTRAINT "RightsContentHashEvent_bookVersionId_fkey" FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE SET NULL;
ALTER TABLE "RightsContentHashEvent" ADD CONSTRAINT "RightsContentHashEvent_rightsProfileId_fkey" FOREIGN KEY ("rightsProfileId") REFERENCES "RightsProfile"("id") ON DELETE SET NULL;
ALTER TABLE "RightsContentHashEvent" ADD CONSTRAINT "RightsContentHashEvent_rightsReviewId_fkey" FOREIGN KEY ("rightsReviewId") REFERENCES "RightsReview"("id") ON DELETE SET NULL;
ALTER TABLE "RightsContentHashEvent" ADD CONSTRAINT "RightsContentHashEvent_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL;
