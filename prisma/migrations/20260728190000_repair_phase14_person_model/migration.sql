-- Repair migration for Phase 14 (Contributors / Person model).
--
-- Production recorded `20260727000000_phase14_contributors_person_model` as applied while its
-- objects were absent from the database, so the first migration to reference `Person`
-- (`20260728200000_add_rights_claims`, Phase 16) failed with `relation "Person" does not exist`.
--
-- Every statement below is idempotent: it is a no-op where Phase 14 applied correctly (CI, dev)
-- and it creates only what is missing where it did not. It is deliberately ordered before the
-- Phase 16 migration so `prisma migrate deploy` repairs the schema first.

-- CreateEnum (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ContributorRole') THEN
    CREATE TYPE "ContributorRole" AS ENUM ('AUTHOR', 'TRANSLATOR', 'EDITOR', 'ILLUSTRATOR', 'NARRATOR', 'ADAPTER', 'COMPILER', 'COMMENTATOR', 'INTRODUCTION_AUTHOR', 'AFTERWORD_AUTHOR', 'COVER_ARTIST', 'RIGHTS_HOLDER', 'OTHER');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PersonType') THEN
    CREATE TYPE "PersonType" AS ENUM ('NATURAL_PERSON', 'ORGANIZATION', 'UNKNOWN');
  END IF;
END $$;

-- Reconcile "ContributorRole" with schema.prisma.
--
-- Production carries an older value set left by the first Phase 14 attempt
-- (PHOTOGRAPHER, ANNOTATION_AUTHOR, COVER_DESIGNER, CARTOGRAPHER) and is missing five roles the
-- application actually writes. The guard above would have skipped the type and left it broken,
-- so the missing labels are added explicitly. The obsolete ones stay: PostgreSQL cannot drop an
-- enum value without rebuilding the type, and unused labels are harmless.
--
-- These are top-level statements on purpose — `ALTER TYPE ... ADD VALUE` is not allowed inside a
-- DO block. `IF NOT EXISTS` makes each one idempotent, and on PostgreSQL 12+ (CI and production
-- both run 14) they are safe inside a transaction as long as the value is not used in it.
ALTER TYPE "ContributorRole" ADD VALUE IF NOT EXISTS 'NARRATOR';
ALTER TYPE "ContributorRole" ADD VALUE IF NOT EXISTS 'COMMENTATOR';
ALTER TYPE "ContributorRole" ADD VALUE IF NOT EXISTS 'AFTERWORD_AUTHOR';
ALTER TYPE "ContributorRole" ADD VALUE IF NOT EXISTS 'COVER_ARTIST';
ALTER TYPE "ContributorRole" ADD VALUE IF NOT EXISTS 'RIGHTS_HOLDER';

-- CreateTable
CREATE TABLE IF NOT EXISTS "Person" (
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
CREATE TABLE IF NOT EXISTS "PersonTranslation" (
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
CREATE TABLE IF NOT EXISTS "BookVersionContributor" (
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
CREATE TABLE IF NOT EXISTS "RightsProfileContributor" (
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
    "creditedLanguage" TEXT,
    "publicDomainFromYear" INTEGER,
    "sourceEvidenceIds" JSONB,
    "confidence" "RightsConfidence",
    "notesRu" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RightsProfileContributor_pkey" PRIMARY KEY ("id")
);

-- The Phase 14 migration file was edited after it was first applied, so an environment may hold
-- an older shape of these tables. Re-add every column defensively.
ALTER TABLE "Person" ADD COLUMN IF NOT EXISTS "nationalityCountryCode" TEXT;
ALTER TABLE "Person" ADD COLUMN IF NOT EXISTS "publicDomainFromYear" INTEGER;
ALTER TABLE "Person" ADD COLUMN IF NOT EXISTS "wikidataId" TEXT;
ALTER TABLE "Person" ADD COLUMN IF NOT EXISTS "viafId" TEXT;
ALTER TABLE "Person" ADD COLUMN IF NOT EXISTS "isni" TEXT;
ALTER TABLE "Person" ADD COLUMN IF NOT EXISTS "gutenbergAgentId" TEXT;
ALTER TABLE "Person" ADD COLUMN IF NOT EXISTS "notesRu" TEXT;

ALTER TABLE "PersonTranslation" ADD COLUMN IF NOT EXISTS "shortDescription" TEXT;
ALTER TABLE "PersonTranslation" ADD COLUMN IF NOT EXISTS "wikidataUrl" TEXT;
ALTER TABLE "PersonTranslation" ADD COLUMN IF NOT EXISTS "wikipediaUrl" TEXT;
ALTER TABLE "PersonTranslation" ADD COLUMN IF NOT EXISTS "photoUrl" TEXT;
ALTER TABLE "PersonTranslation" ADD COLUMN IF NOT EXISTS "seoId" INTEGER;

ALTER TABLE "BookVersionContributor" ADD COLUMN IF NOT EXISTS "roleOtherRu" TEXT;
ALTER TABLE "BookVersionContributor" ADD COLUMN IF NOT EXISTS "creditedName" TEXT;
ALTER TABLE "BookVersionContributor" ADD COLUMN IF NOT EXISTS "creditedLanguage" TEXT;
ALTER TABLE "BookVersionContributor" ADD COLUMN IF NOT EXISTS "contributionNoteRu" TEXT;
ALTER TABLE "BookVersionContributor" ADD COLUMN IF NOT EXISTS "sourceEvidenceIds" JSONB;
ALTER TABLE "BookVersionContributor" ADD COLUMN IF NOT EXISTS "confidence" "RightsConfidence";

ALTER TABLE "RightsProfileContributor" ADD COLUMN IF NOT EXISTS "rightsComponentId" TEXT;
ALTER TABLE "RightsProfileContributor" ADD COLUMN IF NOT EXISTS "roleOtherRu" TEXT;
ALTER TABLE "RightsProfileContributor" ADD COLUMN IF NOT EXISTS "canonicalName" TEXT;
ALTER TABLE "RightsProfileContributor" ADD COLUMN IF NOT EXISTS "creditedName" TEXT;
ALTER TABLE "RightsProfileContributor" ADD COLUMN IF NOT EXISTS "birthYear" INTEGER;
ALTER TABLE "RightsProfileContributor" ADD COLUMN IF NOT EXISTS "deathYear" INTEGER;
ALTER TABLE "RightsProfileContributor" ADD COLUMN IF NOT EXISTS "nationalityCountryCode" TEXT;
ALTER TABLE "RightsProfileContributor" ADD COLUMN IF NOT EXISTS "wikidataId" TEXT;
ALTER TABLE "RightsProfileContributor" ADD COLUMN IF NOT EXISTS "viafId" TEXT;
ALTER TABLE "RightsProfileContributor" ADD COLUMN IF NOT EXISTS "isni" TEXT;
ALTER TABLE "RightsProfileContributor" ADD COLUMN IF NOT EXISTS "gutenbergAgentId" TEXT;
ALTER TABLE "RightsProfileContributor" ADD COLUMN IF NOT EXISTS "creditedLanguage" TEXT;
ALTER TABLE "RightsProfileContributor" ADD COLUMN IF NOT EXISTS "publicDomainFromYear" INTEGER;
ALTER TABLE "RightsProfileContributor" ADD COLUMN IF NOT EXISTS "sourceEvidenceIds" JSONB;
ALTER TABLE "RightsProfileContributor" ADD COLUMN IF NOT EXISTS "confidence" "RightsConfidence";
ALTER TABLE "RightsProfileContributor" ADD COLUMN IF NOT EXISTS "notesRu" TEXT;

-- AddColumn to Author (legacy bridge)
ALTER TABLE "Author" ADD COLUMN IF NOT EXISTS "personId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Person_slug_key" ON "Person"("slug");
CREATE INDEX IF NOT EXISTS "Person_canonicalName_idx" ON "Person"("canonicalName");
CREATE INDEX IF NOT EXISTS "Person_sortName_idx" ON "Person"("sortName");
CREATE INDEX IF NOT EXISTS "Person_birthYear_idx" ON "Person"("birthYear");
CREATE INDEX IF NOT EXISTS "Person_deathYear_idx" ON "Person"("deathYear");
CREATE INDEX IF NOT EXISTS "Person_publicDomainFromYear_idx" ON "Person"("publicDomainFromYear");
CREATE INDEX IF NOT EXISTS "Person_wikidataId_idx" ON "Person"("wikidataId");
CREATE INDEX IF NOT EXISTS "Person_viafId_idx" ON "Person"("viafId");
CREATE INDEX IF NOT EXISTS "Person_isni_idx" ON "Person"("isni");
CREATE INDEX IF NOT EXISTS "Person_gutenbergAgentId_idx" ON "Person"("gutenbergAgentId");

-- CreateIndex PersonTranslation
CREATE UNIQUE INDEX IF NOT EXISTS "PersonTranslation_seoId_key" ON "PersonTranslation"("seoId");
CREATE INDEX IF NOT EXISTS "PersonTranslation_personId_idx" ON "PersonTranslation"("personId");
CREATE INDEX IF NOT EXISTS "PersonTranslation_language_idx" ON "PersonTranslation"("language");
CREATE UNIQUE INDEX IF NOT EXISTS "PersonTranslation_personId_language_key" ON "PersonTranslation"("personId", "language");
CREATE UNIQUE INDEX IF NOT EXISTS "PersonTranslation_language_slug_key" ON "PersonTranslation"("language", "slug");

-- CreateIndex BookVersionContributor
CREATE INDEX IF NOT EXISTS "BookVersionContributor_bookVersionId_idx" ON "BookVersionContributor"("bookVersionId");
CREATE INDEX IF NOT EXISTS "BookVersionContributor_personId_idx" ON "BookVersionContributor"("personId");
CREATE INDEX IF NOT EXISTS "BookVersionContributor_role_idx" ON "BookVersionContributor"("role");
CREATE INDEX IF NOT EXISTS "BookVersionContributor_isPrimary_idx" ON "BookVersionContributor"("isPrimary");
CREATE INDEX IF NOT EXISTS "BookVersionContributor_displayOrder_idx" ON "BookVersionContributor"("displayOrder");

-- CreateIndex RightsProfileContributor
CREATE INDEX IF NOT EXISTS "RightsProfileContributor_rightsProfileId_idx" ON "RightsProfileContributor"("rightsProfileId");
CREATE INDEX IF NOT EXISTS "RightsProfileContributor_rightsComponentId_idx" ON "RightsProfileContributor"("rightsComponentId");
CREATE INDEX IF NOT EXISTS "RightsProfileContributor_personId_idx" ON "RightsProfileContributor"("personId");
CREATE INDEX IF NOT EXISTS "RightsProfileContributor_role_idx" ON "RightsProfileContributor"("role");
CREATE INDEX IF NOT EXISTS "RightsProfileContributor_publicDomainFromYear_idx" ON "RightsProfileContributor"("publicDomainFromYear");

-- CreateIndex Author
CREATE INDEX IF NOT EXISTS "Author_personId_idx" ON "Author"("personId");

-- AddForeignKey (idempotent — pg has no ADD CONSTRAINT IF NOT EXISTS)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Author_personId_fkey') THEN
    ALTER TABLE "Author" ADD CONSTRAINT "Author_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PersonTranslation_personId_fkey') THEN
    ALTER TABLE "PersonTranslation" ADD CONSTRAINT "PersonTranslation_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PersonTranslation_seoId_fkey') THEN
    ALTER TABLE "PersonTranslation" ADD CONSTRAINT "PersonTranslation_seoId_fkey" FOREIGN KEY ("seoId") REFERENCES "Seo"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BookVersionContributor_bookVersionId_fkey') THEN
    ALTER TABLE "BookVersionContributor" ADD CONSTRAINT "BookVersionContributor_bookVersionId_fkey" FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BookVersionContributor_personId_fkey') THEN
    ALTER TABLE "BookVersionContributor" ADD CONSTRAINT "BookVersionContributor_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsProfileContributor_rightsProfileId_fkey') THEN
    ALTER TABLE "RightsProfileContributor" ADD CONSTRAINT "RightsProfileContributor_rightsProfileId_fkey" FOREIGN KEY ("rightsProfileId") REFERENCES "RightsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsProfileContributor_rightsComponentId_fkey') THEN
    ALTER TABLE "RightsProfileContributor" ADD CONSTRAINT "RightsProfileContributor_rightsComponentId_fkey" FOREIGN KEY ("rightsComponentId") REFERENCES "RightsComponent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsProfileContributor_personId_fkey') THEN
    ALTER TABLE "RightsProfileContributor" ADD CONSTRAINT "RightsProfileContributor_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Backfill legacy Author records into Person.
--
-- `ON CONFLICT DO NOTHING` is the difference from the original Phase 14 statement: `Person.slug`
-- is unique, and two authors whose translations resolve to the same slug make the plain INSERT
-- abort the whole (transactional) migration — the most likely reason Phase 14 never landed on
-- production. Colliding authors are linked to the existing Person by the UPDATE below instead.
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
ORDER BY a."id", CASE WHEN at."language" = 'en' THEN 1 WHEN at."language" = 'ru' THEN 2 ELSE 3 END
ON CONFLICT DO NOTHING;

-- Update Author.personId linking to newly created Person by matching slug from AuthorTranslation
UPDATE "Author" a
SET "personId" = p."id"
FROM "AuthorTranslation" at
JOIN "Person" p ON p."slug" = at."slug"
WHERE a."id" = at."authorId" AND a."personId" IS NULL;

-- Backfill legacy AuthorTranslation records into PersonTranslation.
-- Same reasoning as above: (personId, language), (language, slug) and seoId are all unique, and
-- authors collapsed onto a shared Person by the slug collision above would collide here too.
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
WHERE a."personId" IS NOT NULL AND pt."id" IS NULL
ON CONFLICT DO NOTHING;
