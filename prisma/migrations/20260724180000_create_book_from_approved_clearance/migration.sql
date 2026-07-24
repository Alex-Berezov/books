-- Phase 6: Create Book from Approved Clearance

-- Add rights fields to Book
ALTER TABLE "Book" ADD COLUMN "rightsIntakeId" TEXT;
ALTER TABLE "Book" ADD COLUMN "currentRightsProfileId" TEXT;
ALTER TABLE "Book" ADD COLUMN "approvedRightsReviewId" TEXT;
ALTER TABLE "Book" ADD COLUMN "rightsCreatedAt" TIMESTAMP(3);

-- Add unique constraint to rightsIntakeId
CREATE UNIQUE INDEX "Book_rightsIntakeId_key" ON "Book"("rightsIntakeId");

-- Add indexes to Book
CREATE INDEX "Book_rightsIntakeId_idx" ON "Book"("rightsIntakeId");
CREATE INDEX "Book_currentRightsProfileId_idx" ON "Book"("currentRightsProfileId");
CREATE INDEX "Book_approvedRightsReviewId_idx" ON "Book"("approvedRightsReviewId");

-- Add rights fields to BookVersion
ALTER TABLE "BookVersion" ADD COLUMN "rightsProfileId" TEXT;
ALTER TABLE "BookVersion" ADD COLUMN "approvedRightsReviewId" TEXT;
ALTER TABLE "BookVersion" ADD COLUMN "rightsStatus" TEXT;
ALTER TABLE "BookVersion" ADD COLUMN "rightsAllowedCountryCodes" JSONB;
ALTER TABLE "BookVersion" ADD COLUMN "rightsBlockedCountryCodes" JSONB;
ALTER TABLE "BookVersion" ADD COLUMN "rightsLicenseRequiredCountryCodes" JSONB;
ALTER TABLE "BookVersion" ADD COLUMN "rightsPendingCountryCodes" JSONB;
ALTER TABLE "BookVersion" ADD COLUMN "rightsRequiredActions" JSONB;

-- Add indexes to BookVersion
CREATE INDEX "BookVersion_rightsProfileId_idx" ON "BookVersion"("rightsProfileId");
CREATE INDEX "BookVersion_approvedRightsReviewId_idx" ON "BookVersion"("approvedRightsReviewId");

-- Add unique constraint to createdBookId in RightsIntake
ALTER TABLE "RightsIntake" ADD CONSTRAINT "RightsIntake_createdBookId_key" UNIQUE ("createdBookId");

-- Add foreign keys for Book
ALTER TABLE "Book" ADD CONSTRAINT "Book_rightsIntakeId_fkey" FOREIGN KEY ("rightsIntakeId") REFERENCES "RightsIntake"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Book" ADD CONSTRAINT "Book_currentRightsProfileId_fkey" FOREIGN KEY ("currentRightsProfileId") REFERENCES "RightsProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Book" ADD CONSTRAINT "Book_approvedRightsReviewId_fkey" FOREIGN KEY ("approvedRightsReviewId") REFERENCES "RightsReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add foreign keys for BookVersion
ALTER TABLE "BookVersion" ADD CONSTRAINT "BookVersion_rightsProfileId_fkey" FOREIGN KEY ("rightsProfileId") REFERENCES "RightsProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BookVersion" ADD CONSTRAINT "BookVersion_approvedRightsReviewId_fkey" FOREIGN KEY ("approvedRightsReviewId") REFERENCES "RightsReview"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Add foreign key for RightsIntake.createdBookId
ALTER TABLE "RightsIntake" ADD CONSTRAINT "RightsIntake_createdBookId_fkey" FOREIGN KEY ("createdBookId") REFERENCES "Book"("id") ON DELETE SET NULL ON UPDATE CASCADE;
