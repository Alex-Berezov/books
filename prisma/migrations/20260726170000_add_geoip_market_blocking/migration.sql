-- Phase 12: GeoIP Market Blocking

DO $$ BEGIN
  CREATE TYPE "GeoBlockScope" AS ENUM (
    'ENTIRE_BOOK',
    'LANGUAGE_EDITION',
    'TEXT_READER',
    'DOWNLOADS',
    'AUDIO',
    'SPECIFIC_ASSET'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "BookVersion" ADD COLUMN "rightsGeoBlockVerifiedAt" TIMESTAMP(3);
ALTER TABLE "BookVersion" ADD COLUMN "rightsGeoBlockVerifiedByUserId" TEXT;
ALTER TABLE "BookVersion" ADD COLUMN "rightsGeoBlockLastGeneratedAt" TIMESTAMP(3);

CREATE TABLE "GeoBlockRule" (
  "id" TEXT NOT NULL,
  "bookId" TEXT,
  "bookVersionId" TEXT,
  "rightsProfileId" TEXT,
  "territoryDecisionId" TEXT,
  "scope" "GeoBlockScope" NOT NULL,
  "countryCode" TEXT NOT NULL,
  "accessPolicy" "RightsAccessPolicy" NOT NULL,
  "sourceFinalStatus" "TerritoryRightsStatus",
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "reasonRu" TEXT,
  "legalBasisRu" TEXT,
  "generatedFrom" TEXT NOT NULL DEFAULT 'TERRITORY_DECISION',
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verifiedAt" TIMESTAMP(3),
  "verifiedByUserId" TEXT,
  "verificationNotesRu" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "GeoBlockRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BookVersion_rightsGeoBlockVerifiedByUserId_idx"
  ON "BookVersion"("rightsGeoBlockVerifiedByUserId");
CREATE INDEX "GeoBlockRule_bookId_idx" ON "GeoBlockRule"("bookId");
CREATE INDEX "GeoBlockRule_bookVersionId_idx" ON "GeoBlockRule"("bookVersionId");
CREATE INDEX "GeoBlockRule_rightsProfileId_idx" ON "GeoBlockRule"("rightsProfileId");
CREATE INDEX "GeoBlockRule_territoryDecisionId_idx" ON "GeoBlockRule"("territoryDecisionId");
CREATE INDEX "GeoBlockRule_countryCode_idx" ON "GeoBlockRule"("countryCode");
CREATE INDEX "GeoBlockRule_scope_idx" ON "GeoBlockRule"("scope");
CREATE INDEX "GeoBlockRule_isActive_idx" ON "GeoBlockRule"("isActive");
CREATE INDEX "GeoBlockRule_verifiedByUserId_idx" ON "GeoBlockRule"("verifiedByUserId");
CREATE UNIQUE INDEX "GeoBlockRule_bookVersionId_scope_countryCode_key"
  ON "GeoBlockRule"("bookVersionId", "scope", "countryCode");

ALTER TABLE "BookVersion"
  ADD CONSTRAINT "BookVersion_rightsGeoBlockVerifiedByUserId_fkey"
  FOREIGN KEY ("rightsGeoBlockVerifiedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "GeoBlockRule"
  ADD CONSTRAINT "GeoBlockRule_bookId_fkey"
  FOREIGN KEY ("bookId") REFERENCES "Book"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GeoBlockRule"
  ADD CONSTRAINT "GeoBlockRule_bookVersionId_fkey"
  FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeoBlockRule"
  ADD CONSTRAINT "GeoBlockRule_rightsProfileId_fkey"
  FOREIGN KEY ("rightsProfileId") REFERENCES "RightsProfile"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GeoBlockRule"
  ADD CONSTRAINT "GeoBlockRule_territoryDecisionId_fkey"
  FOREIGN KEY ("territoryDecisionId") REFERENCES "TerritoryDecision"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "GeoBlockRule"
  ADD CONSTRAINT "GeoBlockRule_verifiedByUserId_fkey"
  FOREIGN KEY ("verifiedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
