-- AlterTable
ALTER TABLE "Author" ADD COLUMN "photoUrl" TEXT;

-- AlterTable
ALTER TABLE "AuthorTranslation" ADD COLUMN "seoId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "AuthorTranslation_seoId_key" ON "AuthorTranslation"("seoId");

-- AddForeignKey
ALTER TABLE "AuthorTranslation" ADD CONSTRAINT "AuthorTranslation_seoId_fkey" FOREIGN KEY ("seoId") REFERENCES "Seo"("id") ON DELETE SET NULL ON UPDATE CASCADE;
