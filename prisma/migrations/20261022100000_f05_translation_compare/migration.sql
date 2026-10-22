-- Сравнение моделей перевода на главе (F05-3, `books-app-docs/features/F05-book-translation/batches.md`):
-- сравнение, колонки по моделям и переведённые куски. Версия не создаётся, глоссарий не пишется.
-- Только добавление: прежний образ этих объектов не знает и не трогает.
-- Откат: `DROP TABLE` трёх таблиц и типа - только через владельца (тема 2), если в них есть строки.
-- Каждый оператор переживает повторный накат (ADR-018).

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "TranslationCompareModelStatus" AS ENUM ('queued', 'running', 'done', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "TranslationCompare" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "bookVersionId" TEXT NOT NULL,
    "chapterNumber" INTEGER NOT NULL,
    "language" "Language" NOT NULL,
    "sourceLanguage" "Language" NOT NULL,
    "chapterFingerprint" TEXT NOT NULL,
    "chunks" JSONB,
    "splitPicks" JSONB NOT NULL DEFAULT '{}',
    "dossierId" TEXT,
    "glossaryId" TEXT,
    "waitingFor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranslationCompare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "TranslationCompareModel" (
    "id" TEXT NOT NULL,
    "compareId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "status" "TranslationCompareModelStatus" NOT NULL DEFAULT 'queued',
    "html" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranslationCompareModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "TranslationCompareChunk" (
    "id" TEXT NOT NULL,
    "compareModelId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "blocks" JSONB NOT NULL,
    "callId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranslationCompareChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TranslationCompare_operationId_key" ON "TranslationCompare"("operationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TranslationCompare_bookVersionId_createdAt_idx" ON "TranslationCompare"("bookVersionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TranslationCompareModel_compareId_model_key" ON "TranslationCompareModel"("compareId", "model");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TranslationCompareModel_compareId_position_key" ON "TranslationCompareModel"("compareId", "position");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TranslationCompareChunk_compareModelId_chunkIndex_key" ON "TranslationCompareChunk"("compareModelId", "chunkIndex");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "TranslationCompare" ADD CONSTRAINT "TranslationCompare_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "LlmOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "TranslationCompare" ADD CONSTRAINT "TranslationCompare_bookVersionId_fkey" FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "TranslationCompareModel" ADD CONSTRAINT "TranslationCompareModel_compareId_fkey" FOREIGN KEY ("compareId") REFERENCES "TranslationCompare"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "TranslationCompareChunk" ADD CONSTRAINT "TranslationCompareChunk_compareModelId_fkey" FOREIGN KEY ("compareModelId") REFERENCES "TranslationCompareModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
