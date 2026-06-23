-- CreateTable
CREATE TABLE "Author" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "birthDate" TEXT,
    "deathDate" TEXT,
    "wikidataUrl" TEXT,
    "wikipediaUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Author_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthorTranslation" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "language" "Language" NOT NULL,
    "name" TEXT NOT NULL,
    "biography" TEXT,
    "quotes" JSONB,
    "faq" JSONB,
    "similarSlugs" JSONB,

    CONSTRAINT "AuthorTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Author_slug_key" ON "Author"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorTranslation_authorId_language_key" ON "AuthorTranslation"("authorId", "language");

-- AddForeignKey
ALTER TABLE "BookVersion" ADD COLUMN "authorId" TEXT;
ALTER TABLE "BookVersion" ADD CONSTRAINT "BookVersion_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Author"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "BookVersion_authorId_idx" ON "BookVersion"("authorId");

-- AddForeignKey
ALTER TABLE "AuthorTranslation" ADD CONSTRAINT "AuthorTranslation_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Author"("id") ON DELETE CASCADE ON UPDATE CASCADE;
