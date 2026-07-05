-- ============================================================
-- Migration: add_key_to_taxonomies
-- Date: 2026-07-05
-- Purpose:
--   1. Add 'key' field to Category (unique, stable identifier)
--   2. Add 'key' field to Tag (unique, stable identifier)
--   3. Add indexable/isVisible/sortOrder to Tag
-- ============================================================

-- -----------------------------------------------------------
-- 1. Add 'key' to Category (backfill from slug, then set NOT NULL)
-- -----------------------------------------------------------
ALTER TABLE "Category" ADD COLUMN "key" TEXT;

-- Backfill existing rows with their slug value
UPDATE "Category" SET "key" = "slug" WHERE "key" IS NULL;

-- Check for duplicate keys before adding unique constraint
DO \$\$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT "key" FROM "Category" GROUP BY "key" HAVING COUNT(*) > 1
  ) dup;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Duplicate keys found in Category table (%)', dup_count;
  END IF;
END \$\$;

ALTER TABLE "Category" ALTER COLUMN "key" SET NOT NULL;
CREATE UNIQUE INDEX "Category_key_key" ON "Category"("key");

-- -----------------------------------------------------------
-- 2. Add 'key' to Tag (backfill from slug, then set NOT NULL)
-- -----------------------------------------------------------
ALTER TABLE "Tag" ADD COLUMN "key" TEXT;

-- Backfill existing rows with their slug value
UPDATE "Tag" SET "key" = "slug" WHERE "key" IS NULL;

-- Check for duplicate keys before adding unique constraint
DO \$\$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT "key" FROM "Tag" GROUP BY "key" HAVING COUNT(*) > 1
  ) dup;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Duplicate keys found in Tag table (%)', dup_count;
  END IF;
END \$\$;

ALTER TABLE "Tag" ALTER COLUMN "key" SET NOT NULL;
CREATE UNIQUE INDEX "Tag_key_key" ON "Tag"("key");

-- -----------------------------------------------------------
-- 3. Add indexable/isVisible/sortOrder to Tag
-- -----------------------------------------------------------
ALTER TABLE "Tag" ADD COLUMN "indexable" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Tag" ADD COLUMN "isVisible" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Tag" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- -----------------------------------------------------------
-- 4. Add relatedCategorySlugs and relatedCollectionSlugs to TagTranslation
-- -----------------------------------------------------------
ALTER TABLE "TagTranslation" ADD COLUMN "relatedCategorySlugs" JSONB;
ALTER TABLE "TagTranslation" ADD COLUMN "relatedCollectionSlugs" JSONB;
