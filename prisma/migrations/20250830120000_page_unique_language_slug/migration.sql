-- Adjust Page unique constraints for multisite i18n
-- Drop old unique index on slug (if exists) and create composite unique (language, slug)

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'Page_slug_key'
  ) THEN
    EXECUTE 'DROP INDEX IF EXISTS "public"."Page_slug_key"';
  END IF;
END $$;

-- Ensure separate index on language for faster lookups
CREATE INDEX IF NOT EXISTS "Page_language_idx" ON "public"."Page"("language");

-- Create composite unique index
CREATE UNIQUE INDEX IF NOT EXISTS "Page_language_slug_key" ON "public"."Page"("language", "slug");
