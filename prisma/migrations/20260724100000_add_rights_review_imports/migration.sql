-- CreateEnum
CREATE TYPE "RightsReviewImportStatus" AS ENUM ('VALIDATED', 'VALIDATION_FAILED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "RightsReviewImport" (
    "id" TEXT NOT NULL,
    "rightsIntakeId" TEXT NOT NULL,
    "schemaVersion" TEXT,
    "importStatus" "RightsReviewImportStatus" NOT NULL DEFAULT 'VALIDATION_FAILED',
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "reportJson" JSONB NOT NULL,
    "reportMarkdown" TEXT,
    "rawAgentOutput" TEXT,
    "sourceFileName" TEXT,
    "reportJsonSha256" TEXT,
    "reportMarkdownSha256" TEXT,
    "rawAgentOutputSha256" TEXT,
    "validationErrors" JSONB,
    "validationWarnings" JSONB,
    "importedByUserId" TEXT,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RightsReviewImport_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "RightsReviewImport" ADD CONSTRAINT "RightsReviewImport_rightsIntakeId_fkey" FOREIGN KEY ("rightsIntakeId") REFERENCES "RightsIntake"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsReviewImport" ADD CONSTRAINT "RightsReviewImport_importedByUserId_fkey" FOREIGN KEY ("importedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "RightsReviewImport_rightsIntakeId_idx" ON "RightsReviewImport"("rightsIntakeId");
CREATE INDEX "RightsReviewImport_importStatus_idx" ON "RightsReviewImport"("importStatus");
CREATE INDEX "RightsReviewImport_isCurrent_idx" ON "RightsReviewImport"("isCurrent");
CREATE INDEX "RightsReviewImport_createdAt_idx" ON "RightsReviewImport"("createdAt");
CREATE INDEX "RightsReviewImport_importedByUserId_idx" ON "RightsReviewImport"("importedByUserId");