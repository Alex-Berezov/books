-- AlterTable
ALTER TABLE "BookVersion" ADD COLUMN "primaryCategoryId" TEXT;

-- CreateIndex
CREATE INDEX "BookVersion_primaryCategoryId_idx" ON "BookVersion"("primaryCategoryId");

-- AddForeignKey
ALTER TABLE "BookVersion" ADD CONSTRAINT "BookVersion_primaryCategoryId_fkey" FOREIGN KEY ("primaryCategoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
