-- ============================================================
-- Migration: taxonomy_restructure
-- Date: 2026-06-30
-- Purpose: Split Category into category/genre/collection types,
--          add SEO fields to CategoryTranslation,
--          add metadata fields to Category and BookCategory
-- ============================================================

-- -----------------------------------------------------------
-- 1. Replace CategoryType enum
--    Old values: genre, popular, author (may vary)
--    New values: category, genre, collection
-- -----------------------------------------------------------

-- Create new enum type with target values
CREATE TYPE "CategoryType_new" AS ENUM ('category', 'genre', 'collection');

-- Map old values to new ones during cast:
--   genre    -> genre    (stays the same)
--   popular  -> collection
--   author   -> collection
ALTER TABLE "Category"
  ALTER COLUMN "type" TYPE "CategoryType_new"
  USING CASE
    WHEN "type"::text = 'genre'    THEN 'genre'::"CategoryType_new"
    WHEN "type"::text = 'popular'  THEN 'collection'::"CategoryType_new"
    WHEN "type"::text = 'author'   THEN 'collection'::"CategoryType_new"
    ELSE 'category'::"CategoryType_new"
  END;

-- Drop old enum type
DROP TYPE "CategoryType";

-- Rename new enum to original name
ALTER TYPE "CategoryType_new" RENAME TO "CategoryType";

-- -----------------------------------------------------------
-- 2. Add fields to Category
-- -----------------------------------------------------------

ALTER TABLE "Category"
  ADD COLUMN IF NOT EXISTS "indexable" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "isVisible" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- -----------------------------------------------------------
-- 3. Add SEO fields to CategoryTranslation
-- -----------------------------------------------------------

ALTER TABLE "CategoryTranslation"
  ADD COLUMN IF NOT EXISTS "h1"              TEXT,
  ADD COLUMN IF NOT EXISTS "shortDescription" TEXT,
  ADD COLUMN IF NOT EXISTS "metaTitle"       TEXT,
  ADD COLUMN IF NOT EXISTS "metaDescription" TEXT,
  ADD COLUMN IF NOT EXISTS "ogTitle"         TEXT,
  ADD COLUMN IF NOT EXISTS "ogDescription"   TEXT,
  ADD COLUMN IF NOT EXISTS "ogImageUrl"      TEXT,
  ADD COLUMN IF NOT EXISTS "ogImageAlt"      TEXT,
  ADD COLUMN IF NOT EXISTS "faq"             JSONB;

COMMENT ON COLUMN "CategoryTranslation"."h1"              IS 'H1 heading for the category/genre page';
COMMENT ON COLUMN "CategoryTranslation"."shortDescription" IS 'Short description for cards/lists';
COMMENT ON COLUMN "CategoryTranslation"."metaTitle"       IS 'Meta title for SEO';
COMMENT ON COLUMN "CategoryTranslation"."metaDescription" IS 'Meta description for SEO';
COMMENT ON COLUMN "CategoryTranslation"."ogTitle"         IS 'Open Graph title';
COMMENT ON COLUMN "CategoryTranslation"."ogDescription"   IS 'Open Graph description';
COMMENT ON COLUMN "CategoryTranslation"."ogImageUrl"      IS 'Open Graph image URL';
COMMENT ON COLUMN "CategoryTranslation"."ogImageAlt"      IS 'Open Graph image alt text';
COMMENT ON COLUMN "CategoryTranslation"."faq"             IS 'FAQ items as JSON array: [{question: string, answer: string}]';

-- -----------------------------------------------------------
-- 4. Add fields to BookCategory
-- -----------------------------------------------------------

ALTER TABLE "BookCategory"
  ADD COLUMN IF NOT EXISTS "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- -----------------------------------------------------------
-- 5. Create index on Category.type for filtering
-- -----------------------------------------------------------

CREATE INDEX IF NOT EXISTS "Category_type_idx" ON "Category"("type");
