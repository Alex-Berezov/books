-- AlterTable: Add description and seoId to CategoryTranslation
ALTER TABLE "CategoryTranslation" ADD COLUMN "description" TEXT;
ALTER TABLE "CategoryTranslation" ADD COLUMN "seoId" INTEGER;
ALTER TABLE "CategoryTranslation" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "CategoryTranslation" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable: Add description and seoId to TagTranslation
ALTER TABLE "TagTranslation" ADD COLUMN "description" TEXT;
ALTER TABLE "TagTranslation" ADD COLUMN "seoId" INTEGER;
ALTER TABLE "TagTranslation" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "TagTranslation" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex: Unique constraint on seoId for CategoryTranslation
CREATE UNIQUE INDEX "CategoryTranslation_seoId_key" ON "CategoryTranslation"("seoId");

-- CreateIndex: Unique constraint on seoId for TagTranslation
CREATE UNIQUE INDEX "TagTranslation_seoId_key" ON "TagTranslation"("seoId");

-- AddForeignKey: CategoryTranslation -> Seo
ALTER TABLE "CategoryTranslation" ADD CONSTRAINT "CategoryTranslation_seoId_fkey" FOREIGN KEY ("seoId") REFERENCES "Seo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: TagTranslation -> Seo
ALTER TABLE "TagTranslation" ADD CONSTRAINT "TagTranslation_seoId_fkey" FOREIGN KEY ("seoId") REFERENCES "Seo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Update existing CategoryTranslation onDelete to CASCADE
ALTER TABLE "CategoryTranslation" DROP CONSTRAINT IF EXISTS "CategoryTranslation_categoryId_fkey";
ALTER TABLE "CategoryTranslation" ADD CONSTRAINT "CategoryTranslation_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Update existing TagTranslation onDelete to CASCADE
ALTER TABLE "TagTranslation" DROP CONSTRAINT IF EXISTS "TagTranslation_tagId_fkey";
ALTER TABLE "TagTranslation" ADD CONSTRAINT "TagTranslation_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
