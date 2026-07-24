-- CreateEnum (new)
CREATE TYPE "RightsApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');

-- Migrate RightsReviewStatus
-- Old: IMPORTED, SUPERSEDED
-- New: DRAFT, AGENT_COMPLETED, HUMAN_REVIEW_REQUIRED, HUMAN_APPROVED, HUMAN_REJECTED, SUPERSEDED, STALE
-- Map IMPORTED -> HUMAN_REVIEW_REQUIRED in USING clause
ALTER TABLE "RightsReview" ALTER COLUMN "status" DROP DEFAULT;
ALTER TYPE "RightsReviewStatus" RENAME TO "RightsReviewStatus_old";
CREATE TYPE "RightsReviewStatus" AS ENUM ('DRAFT', 'AGENT_COMPLETED', 'HUMAN_REVIEW_REQUIRED', 'HUMAN_APPROVED', 'HUMAN_REJECTED', 'SUPERSEDED', 'STALE');
ALTER TABLE "RightsReview" ALTER COLUMN "status" TYPE "RightsReviewStatus" USING (
  CASE "status"::text
    WHEN 'IMPORTED' THEN 'HUMAN_REVIEW_REQUIRED'::text
    ELSE "status"::text
  END::"RightsReviewStatus"
);
ALTER TABLE "RightsReview" ALTER COLUMN "status" SET DEFAULT 'HUMAN_REVIEW_REQUIRED';
DROP TYPE "RightsReviewStatus_old";

-- Migrate RightsProfileStatus
-- Old: IMPORTED, SUPERSEDED, ARCHIVED
-- New: IMPORTED, HUMAN_REVIEW_REQUIRED, APPROVED, REJECTED, SUPERSEDED, STALE, ARCHIVED
-- IMPORTED exists in both, but we map existing IMPORTED -> HUMAN_REVIEW_REQUIRED via UPDATE
ALTER TABLE "RightsProfile" ALTER COLUMN "status" DROP DEFAULT;
ALTER TYPE "RightsProfileStatus" RENAME TO "RightsProfileStatus_old";
CREATE TYPE "RightsProfileStatus" AS ENUM ('IMPORTED', 'HUMAN_REVIEW_REQUIRED', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'STALE', 'ARCHIVED');
ALTER TABLE "RightsProfile" ALTER COLUMN "status" TYPE "RightsProfileStatus" USING ("status"::text::"RightsProfileStatus");
ALTER TABLE "RightsProfile" ALTER COLUMN "status" SET DEFAULT 'IMPORTED';
DROP TYPE "RightsProfileStatus_old";

-- Data migration: IMPORTED -> HUMAN_REVIEW_REQUIRED for existing RightsProfile records
UPDATE "RightsProfile" SET "status" = 'HUMAN_REVIEW_REQUIRED' WHERE "status"::text = 'IMPORTED';

-- AlterTable: add approval fields to RightsReview
ALTER TABLE "RightsReview" ADD COLUMN "approvedByUserId" TEXT;
ALTER TABLE "RightsReview" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "RightsReview" ADD COLUMN "approvalNotesRu" TEXT;
ALTER TABLE "RightsReview" ADD COLUMN "rejectedByUserId" TEXT;
ALTER TABLE "RightsReview" ADD COLUMN "rejectedAt" TIMESTAMP(3);
ALTER TABLE "RightsReview" ADD COLUMN "rejectionReasonRu" TEXT;

-- CreateTable: RightsReviewApproval
CREATE TABLE "RightsReviewApproval" (
    "id" TEXT NOT NULL,
    "rightsReviewId" TEXT NOT NULL,
    "rightsProfileId" TEXT NOT NULL,
    "rightsIntakeId" TEXT NOT NULL,
    "decision" "RightsApprovalDecision" NOT NULL,
    "decidedByUserId" TEXT,
    "notesRu" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RightsReviewApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RightsReviewApproval_rightsReviewId_idx" ON "RightsReviewApproval"("rightsReviewId");
CREATE INDEX "RightsReviewApproval_rightsProfileId_idx" ON "RightsReviewApproval"("rightsProfileId");
CREATE INDEX "RightsReviewApproval_rightsIntakeId_idx" ON "RightsReviewApproval"("rightsIntakeId");
CREATE INDEX "RightsReviewApproval_decision_idx" ON "RightsReviewApproval"("decision");
CREATE INDEX "RightsReviewApproval_decidedByUserId_idx" ON "RightsReviewApproval"("decidedByUserId");
CREATE INDEX "RightsReviewApproval_createdAt_idx" ON "RightsReviewApproval"("createdAt");

-- AddIndex to RightsReview
CREATE INDEX "RightsReview_approvedByUserId_idx" ON "RightsReview"("approvedByUserId");
CREATE INDEX "RightsReview_rejectedByUserId_idx" ON "RightsReview"("rejectedByUserId");
CREATE INDEX "RightsReview_approvedAt_idx" ON "RightsReview"("approvedAt");
CREATE INDEX "RightsReview_rejectedAt_idx" ON "RightsReview"("rejectedAt");

-- AddForeignKey
ALTER TABLE "RightsReviewApproval" ADD CONSTRAINT "RightsReviewApproval_rightsReviewId_fkey" FOREIGN KEY ("rightsReviewId") REFERENCES "RightsReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RightsReviewApproval" ADD CONSTRAINT "RightsReviewApproval_rightsProfileId_fkey" FOREIGN KEY ("rightsProfileId") REFERENCES "RightsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RightsReviewApproval" ADD CONSTRAINT "RightsReviewApproval_rightsIntakeId_fkey" FOREIGN KEY ("rightsIntakeId") REFERENCES "RightsIntake"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RightsReviewApproval" ADD CONSTRAINT "RightsReviewApproval_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RightsReview" ADD CONSTRAINT "RightsReview_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RightsReview" ADD CONSTRAINT "RightsReview_rejectedByUserId_fkey" FOREIGN KEY ("rejectedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
