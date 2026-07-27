-- CreateEnum
CREATE TYPE "ContributorRole" AS ENUM ('AUTHOR', 'TRANSLATOR', 'EDITOR', 'ILLUSTRATOR', 'PHOTOGRAPHER', 'INTRODUCTION_AUTHOR', 'ANNOTATION_AUTHOR', 'COMPILER', 'ADAPTER', 'COVER_DESIGNER', 'CARTOGRAPHER', 'OTHER');

-- CreateEnum
CREATE TYPE "ContributorIdentityConfidence" AS ENUM ('CONFIRMED', 'PROBABLE', 'UNCERTAIN', 'UNKNOWN');

-- CreateTable
CREATE TABLE "contributors" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "originalName" TEXT,
    "birthDate" TIMESTAMP(3),
    "deathDate" TIMESTAMP(3),
    "birthYear" INTEGER,
    "deathYear" INTEGER,
    "nationalityCountry" TEXT,
    "pseudonym" TEXT,
    "viafId" TEXT,
    "locAuthorityId" TEXT,
    "otherAuthorityIds" JSONB,
    "identityConfidence" "ContributorIdentityConfidence" NOT NULL DEFAULT 'CONFIRMED',
    "notesRu" TEXT,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contributors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_edition_contributors" (
    "id" TEXT NOT NULL,
    "sourceEditionId" TEXT NOT NULL,
    "contributorId" TEXT NOT NULL,
    "role" "ContributorRole" NOT NULL,
    "creditedName" TEXT,
    "notesRu" TEXT,
    "evidenceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_edition_contributors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rights_component_contributors" (
    "id" TEXT NOT NULL,
    "rightsComponentId" TEXT NOT NULL,
    "contributorId" TEXT NOT NULL,
    "role" "ContributorRole" NOT NULL,
    "creditedName" TEXT,
    "notesRu" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rights_component_contributors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contributors_displayName_idx" ON "contributors"("displayName");
CREATE INDEX "contributors_authorId_idx" ON "contributors"("authorId");
CREATE INDEX "contributors_viafId_idx" ON "contributors"("viafId");
CREATE INDEX "contributors_identityConfidence_idx" ON "contributors"("identityConfidence");

-- CreateIndex
CREATE INDEX "source_edition_contributors_sourceEditionId_idx" ON "source_edition_contributors"("sourceEditionId");
CREATE INDEX "source_edition_contributors_contributorId_idx" ON "source_edition_contributors"("contributorId");
CREATE INDEX "source_edition_contributors_role_idx" ON "source_edition_contributors"("role");

-- CreateIndex
CREATE INDEX "rights_component_contributors_rightsComponentId_idx" ON "rights_component_contributors"("rightsComponentId");
CREATE INDEX "rights_component_contributors_contributorId_idx" ON "rights_component_contributors"("contributorId");
CREATE INDEX "rights_component_contributors_role_idx" ON "rights_component_contributors"("role");

-- AddForeignKey
ALTER TABLE "contributors" ADD CONSTRAINT "contributors_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Author"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_edition_contributors" ADD CONSTRAINT "source_edition_contributors_sourceEditionId_fkey" FOREIGN KEY ("sourceEditionId") REFERENCES "SourceEdition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_edition_contributors" ADD CONSTRAINT "source_edition_contributors_contributorId_fkey" FOREIGN KEY ("contributorId") REFERENCES "Contributor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_edition_contributors" ADD CONSTRAINT "source_edition_contributors_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "RightsEvidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rights_component_contributors" ADD CONSTRAINT "rights_component_contributors_rightsComponentId_fkey" FOREIGN KEY ("rightsComponentId") REFERENCES "RightsComponent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rights_component_contributors" ADD CONSTRAINT "rights_component_contributors_contributorId_fkey" FOREIGN KEY ("contributorId") REFERENCES "Contributor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
