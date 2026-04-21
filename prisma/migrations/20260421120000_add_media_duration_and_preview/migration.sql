-- AlterTable MediaAsset: add duration + deletedAt
ALTER TABLE "MediaAsset"
    ADD COLUMN "duration" INTEGER,
    ADD COLUMN "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "MediaAsset_isDeleted_deletedAt_idx" ON "MediaAsset"("isDeleted", "deletedAt");

-- AlterTable BookVersion: add previewMediaId
ALTER TABLE "BookVersion"
    ADD COLUMN "previewMediaId" TEXT;

-- CreateIndex
CREATE INDEX "BookVersion_previewMediaId_idx" ON "BookVersion"("previewMediaId");

-- AddForeignKey
ALTER TABLE "BookVersion"
    ADD CONSTRAINT "BookVersion_previewMediaId_fkey"
    FOREIGN KEY ("previewMediaId") REFERENCES "MediaAsset"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
