-- CreateEnum
CREATE TYPE "ContributorRole" AS ENUM ('AUTHOR', 'TRANSLATOR', 'EDITOR', 'ILLUSTRATOR', 'NARRATOR', 'ADAPTER', 'COMPILER', 'COMMENTATOR', 'INTRODUCTION_AUTHOR', 'AFTERWORD_AUTHOR', 'COVER_ARTIST', 'RIGHTS_HOLDER', 'OTHER');

-- CreateEnum
CREATE TYPE "PersonType" AS ENUM ('NATURAL_PERSON', 'ORGANIZATION', 'UNKNOWN');

-- CreateTable
CREATE TABLE "Person" (
    "id" TEXT NOT NULL,
    "type" "PersonType" NOT NULL DEFAULT 'NATURAL_PERSON',
    "canonicalName" TEXT NOT NULL,
    "sortName" TEXT,
    "slug" TEXT,
    "birthDate" TEXT,
    "deathDate" TEXT,
    "birthYear" INTEGER,
    "deathYear" INTEGER,
    "nationalityCountryCode" TEXT,
    "publicDomainFromYear" INTEGER,
    "wikidataId" TEXT,
    "viafId" TEXT,
    "isni" TEXT,
    "gutenbergAgentId" TEXT,
    "notesRu" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonTranslation" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "language" "Language" NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "biography" TEXT,
    "shortDescription" TEXT,
    "wikidataUrl" TEXT,
    "wikipediaUrl" TEXT,
    "photoUrl" TEXT,
    "seoId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookVersionContributor" (
    "id" TEXT NOT NULL,
    "bookVersionId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "role" "ContributorRole" NOT NULL,
    "roleOtherRu" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "creditedName" TEXT,
    "creditedLanguage" TEXT,
    "contributionNoteRu" TEXT,
    "sourceEvidenceIds" JSONB,
    "confidence" "RightsConfidence",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookVersionContributor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RightsProfileContributor" (
    "id" TEXT NOT NULL,
    "rightsProfileId" TEXT NOT NULL,
    "rightsComponentId" TEXT,
    "personId" TEXT,
    "role" "ContributorRole" NOT NULL,
    "roleOtherRu" TEXT,
    "displayName" TEXT NOT NULL,
    "canonicalName" TEXT,
    "creditedName" TEXT,
    "birthYear" INTEGER,
    "deathYear" INTEGER,
    "nationalityCountryCode" TEXT,
    "wikidataId" TEXT,
    "viafId" TEXT,
    "isni" TEXT,
    "gutenbergAgentId" TEXT,
    "publicDomainFromYear" INTEGER,
    "sourceEvidenceIds" JSONB,
    "confidence" "RightsConfidence",
    "notesRu" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RightsProfileContributor_pkey" PRIMARY KEY ("id")
);

-- AddColumn to Author
ALTER TABLE "Author" ADD COLUMN "personId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Person_slug_key" ON "Person"("slug");
CREATE INDEX "Person_canonicalName_idx" ON "Person"("canonicalName");
CREATE INDEX "Person_sortName_idx" ON "Person"("sortName");
CREATE INDEX "Person_birthYear_idx" ON "Person"("birthYear");
CREATE INDEX "Person_deathYear_idx" ON "Person"("deathYear");
CREATE INDEX "Person_publicDomainFromYear_idx" ON "Person"("publicDomainFromYear");
CREATE INDEX "Person_wikidataId_idx" ON "Person"("wikidataId");
CREATE INDEX "Person_viafId_idx" ON "Person"("viafId");
CREATE INDEX "Person_isni_idx" ON "Person"("isni");
CREATE INDEX "Person_gutenbergAgentId_idx" ON "Person"("gutenbergAgentId");

-- CreateIndex PersonTranslation
CREATE UNIQUE INDEX "PersonTranslation_seoId_key" ON "PersonTranslation"("seoId");
CREATE INDEX "PersonTranslation_personId_idx" ON "PersonTranslation"("personId");
CREATE INDEX "PersonTranslation_language_idx" ON "PersonTranslation"("language");
CREATE UNIQUE INDEX "PersonTranslation_personId_language_key" ON "PersonTranslation"("personId", "language");
CREATE UNIQUE INDEX "PersonTranslation_language_slug_key" ON "PersonTranslation"("language", "slug");

-- CreateIndex BookVersionContributor
CREATE INDEX "BookVersionContributor_bookVersionId_idx" ON "BookVersionContributor"("bookVersionId");
CREATE INDEX "BookVersionContributor_personId_idx" ON "BookVersionContributor"("personId");
CREATE INDEX "BookVersionContributor_role_idx" ON "BookVersionContributor"("role");
CREATE INDEX "BookVersionContributor_isPrimary_idx" ON "BookVersionContributor"("isPrimary");
CREATE INDEX "BookVersionContributor_displayOrder_idx" ON "BookVersionContributor"("displayOrder");

-- CreateIndex RightsProfileContributor
CREATE INDEX "RightsProfileContributor_rightsProfileId_idx" ON "RightsProfileContributor"("rightsProfileId");
CREATE INDEX "RightsProfileContributor_rightsComponentId_idx" ON "RightsProfileContributor"("rightsComponentId");
CREATE INDEX "RightsProfileContributor_personId_idx" ON "RightsProfileContributor"("personId");
CREATE INDEX "RightsProfileContributor_role_idx" ON "RightsProfileContributor"("role");
CREATE INDEX "RightsProfileContributor_publicDomainFromYear_idx" ON "RightsProfileContributor"("publicDomainFromYear");

-- CreateIndex Author
CREATE INDEX "Author_personId_idx" ON "Author"("personId");

-- AddForeignKey
ALTER TABLE "Author" ADD CONSTRAINT "Author_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonTranslation" ADD CONSTRAINT "PersonTranslation_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonTranslation" ADD CONSTRAINT "PersonTranslation_seoId_fkey" FOREIGN KEY ("seoId") REFERENCES "Seo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookVersionContributor" ADD CONSTRAINT "BookVersionContributor_bookVersionId_fkey" FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookVersionContributor" ADD CONSTRAINT "BookVersionContributor_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsProfileContributor" ADD CONSTRAINT "RightsProfileContributor_rightsProfileId_fkey" FOREIGN KEY ("rightsProfileId") REFERENCES "RightsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsProfileContributor" ADD CONSTRAINT "RightsProfileContributor_rightsComponentId_fkey" FOREIGN KEY ("rightsComponentId") REFERENCES "RightsComponent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsProfileContributor" ADD CONSTRAINT "RightsProfileContributor_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill legacy Author records into Person
INSERT INTO "Person" ("id", "type", "canonicalName", "sortName", "slug", "birthDate", "deathDate", "birthYear", "deathYear", "createdAt", "updatedAt")
SELECT DISTINCT ON (a."id")
  gen_random_uuid()::text,
  'NATURAL_PERSON'::"PersonType",
  at."name",
  at."name",
  at."slug",
  a."birthDate",
  a."deathDate",
  CASE WHEN a."birthDate" ~ '^\d{4}' THEN substring(a."birthDate" from 1 for 4)::integer ELSE NULL END,
  CASE WHEN a."deathDate" ~ '^\d{4}' THEN substring(a."deathDate" from 1 for 4)::integer ELSE NULL END,
  a."createdAt",
  a."updatedAt"
FROM "Author" a
JOIN "AuthorTranslation" at ON at."authorId" = a."id"
LEFT JOIN "Person" p ON p."slug" = at."slug"
WHERE p."id" IS NULL
ORDER BY a."id", CASE WHEN at."language" = 'en' THEN 1 WHEN at."language" = 'ru' THEN 2 ELSE 3 END;

-- Update Author.personId linking to newly created Person by matching slug from AuthorTranslation
UPDATE "Author" a
SET "personId" = p."id"
FROM "AuthorTranslation" at
JOIN "Person" p ON p."slug" = at."slug"
WHERE a."id" = at."authorId" AND a."personId" IS NULL;

-- Backfill legacy AuthorTranslation records into PersonTranslation
INSERT INTO "PersonTranslation" ("id", "personId", "language", "slug", "displayName", "biography", "wikidataUrl", "wikipediaUrl", "photoUrl", "seoId", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  a."personId",
  at."language",
  at."slug",
  at."name",
  at."biography",
  at."wikidataUrl",
  at."wikipediaUrl",
  at."photoUrl",
  at."seoId",
  a."createdAt",
  a."updatedAt"
FROM "AuthorTranslation" at
JOIN "Author" a ON a."id" = at."authorId"
LEFT JOIN "PersonTranslation" pt ON pt."personId" = a."personId" AND pt."language" = at."language"
WHERE a."personId" IS NOT NULL AND pt."id" IS NULL;


