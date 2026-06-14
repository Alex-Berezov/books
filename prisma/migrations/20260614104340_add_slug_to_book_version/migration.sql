-- AlterTable
ALTER TABLE "BookVersion" ADD COLUMN "slug" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "BookVersion_language_slug_key" ON "BookVersion"("language", "slug");
