ALTER TABLE "ComponentTerritoryAssessment"
ADD COLUMN "legalBasisRu" TEXT,
ADD COLUMN "publicDomainFromYear" INTEGER,
ADD COLUMN "rightsExpireAt" TIMESTAMP(3),
ADD COLUMN "sourceEvidenceIds" JSONB,
ADD COLUMN "notesRu" TEXT;

CREATE INDEX "ComponentTerritoryAssessment_accessPolicy_idx"
ON "ComponentTerritoryAssessment"("accessPolicy");

CREATE INDEX "ComponentTerritoryAssessment_geoBlockRequired_idx"
ON "ComponentTerritoryAssessment"("geoBlockRequired");

CREATE INDEX "ComponentTerritoryAssessment_rightsExpireAt_idx"
ON "ComponentTerritoryAssessment"("rightsExpireAt");
