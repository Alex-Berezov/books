-- Phase 7: Publication Gate - geo-block fields for BookVersion
ALTER TABLE "BookVersion" ADD COLUMN "rightsGeoBlockRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BookVersion" ADD COLUMN "rightsGeoBlockConfigured" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BookVersion" ADD COLUMN "rightsGeoBlockConfiguredAt" TIMESTAMP(3);
ALTER TABLE "BookVersion" ADD COLUMN "rightsGeoBlockNotesRu" TEXT;
