-- Add SEO and content fields to TagTranslation
-- Migration: 20260629150000_add_seo_fields_to_tag_translations

ALTER TABLE "TagTranslation"
ADD COLUMN "h1" TEXT,
ADD COLUMN "shortDescription" TEXT,
ADD COLUMN "metaTitle" TEXT,
ADD COLUMN "metaDescription" TEXT,
ADD COLUMN "ogTitle" TEXT,
ADD COLUMN "ogDescription" TEXT,
ADD COLUMN "ogImageUrl" TEXT,
ADD COLUMN "ogImageAlt" TEXT,
ADD COLUMN "canonicalUrl" TEXT,
ADD COLUMN "robots" TEXT DEFAULT 'index, follow',
ADD COLUMN "indexable" BOOLEAN DEFAULT true,
ADD COLUMN "faq" JSONB,
ADD COLUMN "relatedTagSlugs" JSONB,
ADD COLUMN "relatedGenreSlugs" JSONB;

-- Add comment explaining the new fields
COMMENT ON COLUMN "TagTranslation"."h1" IS 'H1 heading for the tag page';
COMMENT ON COLUMN "TagTranslation"."shortDescription" IS 'Short description for cards/lists';
COMMENT ON COLUMN "TagTranslation"."metaTitle" IS 'Meta title for SEO';
COMMENT ON COLUMN "TagTranslation"."metaDescription" IS 'Meta description for SEO';
COMMENT ON COLUMN "TagTranslation"."ogTitle" IS 'Open Graph title';
COMMENT ON COLUMN "TagTranslation"."ogDescription" IS 'Open Graph description';
COMMENT ON COLUMN "TagTranslation"."ogImageUrl" IS 'Open Graph image URL';
COMMENT ON COLUMN "TagTranslation"."ogImageAlt" IS 'Open Graph image alt text';
COMMENT ON COLUMN "TagTranslation"."canonicalUrl" IS 'Canonical URL';
COMMENT ON COLUMN "TagTranslation"."robots" IS 'Robots directive (index, follow / noindex, follow)';
COMMENT ON COLUMN "TagTranslation"."indexable" IS 'Whether this tag should be indexed by search engines';
COMMENT ON COLUMN "TagTranslation"."faq" IS 'FAQ items as JSON array: [{question: string, answer: string}]';
COMMENT ON COLUMN "TagTranslation"."relatedTagSlugs" IS 'Related tag slugs as JSON array of strings';
COMMENT ON COLUMN "TagTranslation"."relatedGenreSlugs" IS 'Related genre/category slugs as JSON array of strings';
