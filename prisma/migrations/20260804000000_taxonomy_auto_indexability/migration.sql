-- Taxonomy auto-indexability (tz-seo-subdomain-leak.md, phase 4)
--
-- bookCount     — cached number of published books attached to the term in this language
-- autoIndexable — hysteresis state derived from bookCount
--                 (close at <= 2, open at >= 5, hold in between)
--
-- Defaults keep existing rows indexable; TaxonomyIndexabilityService.recomputeAll()
-- must be run once after deploy to fill in real values.

ALTER TABLE "CategoryTranslation"
  ADD COLUMN "bookCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "autoIndexable" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "TagTranslation"
  ADD COLUMN "bookCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "autoIndexable" BOOLEAN NOT NULL DEFAULT true;

-- Sitemap filters on these columns per language.
CREATE INDEX "CategoryTranslation_language_autoIndexable_idx"
  ON "CategoryTranslation" ("language", "autoIndexable");

CREATE INDEX "TagTranslation_language_autoIndexable_idx"
  ON "TagTranslation" ("language", "autoIndexable");
