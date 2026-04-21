-- AlterTable
ALTER TABLE "AudioChapter"
    ADD COLUMN "description" TEXT,
    ADD COLUMN "transcript" TEXT,
    ADD COLUMN "mediaId" TEXT,
    ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "AudioChapter_mediaId_idx" ON "AudioChapter"("mediaId");

-- AddForeignKey
ALTER TABLE "AudioChapter"
    ADD CONSTRAINT "AudioChapter_mediaId_fkey"
    FOREIGN KEY ("mediaId") REFERENCES "MediaAsset"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
