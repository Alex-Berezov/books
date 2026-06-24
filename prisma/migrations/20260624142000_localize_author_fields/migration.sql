-- AlterTable
ALTER TABLE "AuthorTranslation" ADD COLUMN "slug" TEXT,
ADD COLUMN "wikidataUrl" TEXT,
ADD COLUMN "wikipediaUrl" TEXT,
ADD COLUMN "photoUrl" TEXT;

-- Migrate data from Author to AuthorTranslation for existing entries
-- We map the root-level columns of Author to AuthorTranslation.
-- If an Author has multiple translations, we populate all of them.
-- If no translations exist, we don't have to populate, but since translations are always created with author, they exist.
UPDATE "AuthorTranslation"
SET 
  "slug" = a."slug",
  "wikidataUrl" = a."wikidataUrl",
  "wikipediaUrl" = a."wikipediaUrl",
  "photoUrl" = a."photoUrl"
FROM "Author" a
WHERE "AuthorTranslation"."authorId" = a."id";

-- If any translation slug ended up NULL (e.g. somehow), we fallback to some default format: e.g. language-name-id
-- But name is always required and slug was required on Author, so it won't be NULL.
-- In case some translations had no slug, we set a default one. Just to be safe:
UPDATE "AuthorTranslation"
SET "slug" = LOWER(REPLACE("name", ' ', '-')) || '-' || SUBSTRING("authorId", 1, 8)
WHERE "slug" IS NULL;

-- Now make slug NOT NULL in AuthorTranslation
ALTER TABLE "AuthorTranslation" ALTER COLUMN "slug" SET NOT NULL;

-- DropIndex (old unique constraint on Author.slug)
DROP INDEX "Author_slug_key";

-- AlterTable (drop relocated columns from Author)
ALTER TABLE "Author" DROP COLUMN "slug",
DROP COLUMN "wikidataUrl",
DROP COLUMN "wikipediaUrl",
DROP COLUMN "photoUrl";

-- CreateIndex
CREATE UNIQUE INDEX "AuthorTranslation_language_slug_key" ON "AuthorTranslation"("language", "slug");
