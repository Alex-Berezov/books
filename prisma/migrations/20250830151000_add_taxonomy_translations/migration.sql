-- Drop unique constraints on base slugs (slugs are now unique per translation language)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'Category_slug_key') THEN
    EXECUTE 'DROP INDEX "public"."Category_slug_key"';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'Tag_slug_key') THEN
    EXECUTE 'DROP INDEX "public"."Tag_slug_key"';
  END IF;
END$$;

-- Create CategoryTranslation table
CREATE TABLE IF NOT EXISTS "public"."CategoryTranslation" (
  "id" TEXT NOT NULL,
  "categoryId" TEXT NOT NULL,
  "language" "public"."Language" NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  CONSTRAINT "CategoryTranslation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CategoryTranslation_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "public"."Category"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Indexes and unique constraints for CategoryTranslation
CREATE UNIQUE INDEX IF NOT EXISTS "CategoryTranslation_language_slug_key" ON "public"."CategoryTranslation"("language", "slug");
CREATE UNIQUE INDEX IF NOT EXISTS "CategoryTranslation_categoryId_language_key" ON "public"."CategoryTranslation"("categoryId", "language");
CREATE INDEX IF NOT EXISTS "CategoryTranslation_categoryId_idx" ON "public"."CategoryTranslation"("categoryId");
CREATE INDEX IF NOT EXISTS "CategoryTranslation_language_idx" ON "public"."CategoryTranslation"("language");

-- Create TagTranslation table
CREATE TABLE IF NOT EXISTS "public"."TagTranslation" (
  "id" TEXT NOT NULL,
  "tagId" TEXT NOT NULL,
  "language" "public"."Language" NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  CONSTRAINT "TagTranslation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TagTranslation_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "public"."Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Indexes and unique constraints for TagTranslation
CREATE UNIQUE INDEX IF NOT EXISTS "TagTranslation_language_slug_key" ON "public"."TagTranslation"("language", "slug");
CREATE UNIQUE INDEX IF NOT EXISTS "TagTranslation_tagId_language_key" ON "public"."TagTranslation"("tagId", "language");
CREATE INDEX IF NOT EXISTS "TagTranslation_tagId_idx" ON "public"."TagTranslation"("tagId");
CREATE INDEX IF NOT EXISTS "TagTranslation_language_idx" ON "public"."TagTranslation"("language");
