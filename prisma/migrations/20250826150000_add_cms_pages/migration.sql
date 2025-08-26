-- CreateEnum PublicationStatus if not exists
DO $$ BEGIN
  CREATE TYPE "public"."PublicationStatus" AS ENUM ('draft', 'published');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum PageType if not exists
DO $$ BEGIN
  CREATE TYPE "public"."PageType" AS ENUM ('generic', 'category_index', 'author_index');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateTable Page (idempotent)
DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS "public"."Page" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "public"."PageType" NOT NULL,
    "content" TEXT NOT NULL,
    "status" "public"."PublicationStatus" NOT NULL DEFAULT 'draft',
    "language" "public"."Language" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "seoId" INTEGER,
    CONSTRAINT "Page_pkey" PRIMARY KEY ("id")
  );
EXCEPTION WHEN duplicate_table THEN NULL; END $$;

-- Unique index on slug
CREATE UNIQUE INDEX IF NOT EXISTS "Page_slug_key" ON "public"."Page"("slug");

-- Unique index on seoId
CREATE UNIQUE INDEX IF NOT EXISTS "Page_seoId_key" ON "public"."Page"("seoId");

-- Relation to Seo (SeoForPage)
DO $$ BEGIN
  ALTER TABLE "public"."Page"
  ADD CONSTRAINT "Page_seoId_fkey"
  FOREIGN KEY ("seoId") REFERENCES "public"."Seo"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
