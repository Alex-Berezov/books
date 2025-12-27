/*
  Warnings:

  - A unique constraint covering the columns `[userId,commentId]` on the table `Like` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[userId,bookVersionId]` on the table `Like` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "CategoryTranslation" DROP CONSTRAINT "CategoryTranslation_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "TagTranslation" DROP CONSTRAINT "TagTranslation_tagId_fkey";

-- DropIndex
DROP INDEX "MediaAsset_createdById_idx";

-- AlterTable
ALTER TABLE "Page" ADD COLUMN     "translation_group_id" UUID;

-- CreateIndex
CREATE INDEX "Page_translation_group_id_idx" ON "Page"("translation_group_id");

-- AddForeignKey
ALTER TABLE "CategoryTranslation" ADD CONSTRAINT "CategoryTranslation_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagTranslation" ADD CONSTRAINT "TagTranslation_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
