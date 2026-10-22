-- Досье и глоссарий книги (F05-2, `books-app-docs/features/F05-book-translation/batches.md`):
-- досье по версии-исходнику поколениями, частичные досье глав, глоссарий пары (досье, язык).
-- Только добавление: прежний образ этих объектов не знает и не трогает.
-- Откат: `DROP TABLE` трёх таблиц и типа - только через владельца (тема 2), если в них есть строки.
-- Каждый оператор переживает повторный накат (ADR-018).

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "BookDossierStatus" AS ENUM ('building', 'ready', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "BookDossier" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "sourceVersionId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "formatVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "BookDossierStatus" NOT NULL DEFAULT 'building',
    "data" JSONB,
    "fingerprint" TEXT NOT NULL,
    "plan" JSONB NOT NULL DEFAULT '[]',
    "model" TEXT,
    "operationId" TEXT,
    "previousOperationId" TEXT,
    "takeovers" INTEGER NOT NULL DEFAULT 0,
    "failedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookDossier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "BookDossierPart" (
    "id" TEXT NOT NULL,
    "dossierId" TEXT NOT NULL,
    "chapterNumber" INTEGER NOT NULL,
    "partIndex" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "callId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookDossierPart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "BookGlossary" (
    "id" TEXT NOT NULL,
    "dossierId" TEXT NOT NULL,
    "language" "Language" NOT NULL,
    "status" "BookDossierStatus" NOT NULL DEFAULT 'building',
    "data" JSONB,
    "history" JSONB NOT NULL DEFAULT '[]',
    "model" TEXT,
    "operationId" TEXT,
    "previousOperationId" TEXT,
    "takeovers" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookGlossary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BookDossier_sourceVersionId_generation_idx" ON "BookDossier"("sourceVersionId", "generation");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BookDossier_operationId_idx" ON "BookDossier"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "BookDossier_bookId_sourceVersionId_generation_key" ON "BookDossier"("bookId", "sourceVersionId", "generation");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "BookDossierPart_dossierId_chapterNumber_partIndex_key" ON "BookDossierPart"("dossierId", "chapterNumber", "partIndex");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BookGlossary_operationId_idx" ON "BookGlossary"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "BookGlossary_dossierId_language_key" ON "BookGlossary"("dossierId", "language");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "BookDossier" ADD CONSTRAINT "BookDossier_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "BookDossier" ADD CONSTRAINT "BookDossier_sourceVersionId_fkey" FOREIGN KEY ("sourceVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "BookDossier" ADD CONSTRAINT "BookDossier_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "LlmOperation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "BookDossierPart" ADD CONSTRAINT "BookDossierPart_dossierId_fkey" FOREIGN KEY ("dossierId") REFERENCES "BookDossier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "BookGlossary" ADD CONSTRAINT "BookGlossary_dossierId_fkey" FOREIGN KEY ("dossierId") REFERENCES "BookDossier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "BookGlossary" ADD CONSTRAINT "BookGlossary_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "LlmOperation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
