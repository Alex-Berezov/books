-- CreateEnum
CREATE TYPE "ContributorRole" AS ENUM ('AUTHOR', 'TRANSLATOR', 'EDITOR', 'ILLUSTRATOR', 'PHOTOGRAPHER', 'INTRODUCTION_AUTHOR', 'ANNOTATION_AUTHOR', 'COMPILER', 'ADAPTER', 'COVER_DESIGNER', 'CARTOGRAPHER', 'OTHER');

-- CreateEnum
CREATE TYPE "ContributorIdentityConfidence" AS ENUM ('CONFIRMED', 'PROBABLE', 'UNCERTAIN', 'UNKNOWN');

-- CreateTable
CREATE TABLE "Contributor" (
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

    CONSTRAINT "Contributor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceEditionContributor" (
    "id" TEXT NOT NULL,
    "sourceEditionId" TEXT NOT NULL,
    "contributorId" TEXT NOT NULL,
    "role" "ContributorRole" NOT NULL,
    "creditedName" TEXT,
    "notesRu" TEXT,
    "evidenceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceEditionContributor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RightsComponentContributor" (
    "id" TEXT NOT NULL,
    "rightsComponentId" TEXT NOT NULL,
    "contributorId" TEXT NOT NULL,
    "role" "ContributorRole" NOT NULL,
    "creditedName" TEXT,
    "notesRu" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RightsComponentContributor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Contributor_displayName_idx" ON "Contributor"("displayName");
CREATE INDEX "Contributor_authorId_idx" ON "Contributor"("authorId");
CREATE INDEX "Contributor_viafId_idx" ON "Contributor"("viafId");
CREATE INDEX "Contributor_identityConfidence_idx" ON "Contributor"("identityConfidence");

-- CreateIndex
CREATE INDEX "SourceEditionContributor_sourceEditionId_idx" ON "SourceEditionContributor"("sourceEditionId");
CREATE INDEX "SourceEditionContributor_contributorId_idx" ON "SourceEditionContributor"("contributorId");
CREATE INDEX "SourceEditionContributor_role_idx" ON "SourceEditionContributor"("role");

-- CreateIndex
CREATE INDEX "RightsComponentContributor_rightsComponentId_idx" ON "RightsComponentContributor"("rightsComponentId");
CREATE INDEX "RightsComponentContributor_contributorId_idx" ON "RightsComponentContributor"("contributorId");
CREATE INDEX "RightsComponentContributor_role_idx" ON "RightsComponentContributor"("role");

-- AddForeignKey
ALTER TABLE "Contributor" ADD CONSTRAINT "Contributor_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Author"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceEditionContributor" ADD CONSTRAINT "SourceEditionContributor_sourceEditionId_fkey" FOREIGN KEY ("sourceEditionId") REFERENCES "SourceEdition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceEditionContributor" ADD CONSTRAINT "SourceEditionContributor_contributorId_fkey" FOREIGN KEY ("contributorId") REFERENCES "Contributor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceEditionContributor" ADD CONSTRAINT "SourceEditionContributor_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "RightsEvidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsComponentContributor" ADD CONSTRAINT "RightsComponentContributor_rightsComponentId_fkey" FOREIGN KEY ("rightsComponentId") REFERENCES "RightsComponent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RightsComponentContributor" ADD CONSTRAINT "RightsComponentContributor_contributorId_fkey" FOREIGN KEY ("contributorId") REFERENCES "Contributor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
