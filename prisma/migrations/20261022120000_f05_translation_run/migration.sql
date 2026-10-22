-- Запуск перевода (F05-4a, `books-app-docs/features/F05-book-translation/batches.md`): запуск,
-- его языки и куски, привязка операций к запуску. Ручки старта в этой пачке нет (решение арбитра
-- `F05 | F05-4`): строки заводят только тесты.
-- Только добавление: прежний образ этих объектов не знает и не трогает.
-- Откат: `DROP TABLE` трёх таблиц, двух типов и столбца - только через владельца (тема 2), если в них есть строки.
-- Каждый оператор переживает повторный накат (ADR-018).

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "TranslationRunLanguageStatus" AS ENUM ('pending', 'running', 'done', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "TranslationChunkStatus" AS ENUM ('pending', 'translated', 'checked', 'done', 'flagged');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AlterTable
ALTER TABLE "LlmOperation" ADD COLUMN IF NOT EXISTS "translationRunId" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "TranslationRun" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "bookVersionId" TEXT NOT NULL,
    "sourceLanguage" "Language" NOT NULL,
    "dossierId" TEXT,
    "dossierFingerprint" TEXT,
    "stageModels" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranslationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "TranslationRunLanguage" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "language" "Language" NOT NULL,
    "glossaryId" TEXT,
    "status" "TranslationRunLanguageStatus" NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "reasonModels" TEXT[],
    "chapterNumber" INTEGER,
    "splitPicks" JSONB NOT NULL DEFAULT '{}',
    "waitingFor" TEXT,
    "blockedByOperationId" TEXT,
    "flaggedChunks" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranslationRunLanguage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "TranslationChunk" (
    "id" TEXT NOT NULL,
    "runLanguageId" TEXT NOT NULL,
    "chapterNumber" INTEGER NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "firstBlock" INTEGER NOT NULL,
    "lastBlock" INTEGER NOT NULL,
    "words" INTEGER NOT NULL,
    "chapterFingerprint" TEXT NOT NULL,
    "status" "TranslationChunkStatus" NOT NULL DEFAULT 'pending',
    "rawResponse" JSONB,
    "blocks" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "verdict" JSONB,
    "flagReason" TEXT,
    "model" TEXT,
    "callId" TEXT,
    "costUsd" DECIMAL(14,8),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranslationChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TranslationRun_operationId_key" ON "TranslationRun"("operationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TranslationRun_bookVersionId_createdAt_idx" ON "TranslationRun"("bookVersionId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TranslationRun_dossierId_idx" ON "TranslationRun"("dossierId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TranslationRunLanguage_glossaryId_idx" ON "TranslationRunLanguage"("glossaryId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TranslationRunLanguage_runId_language_key" ON "TranslationRunLanguage"("runId", "language");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TranslationChunk_runLanguageId_chapterNumber_chunkIndex_key" ON "TranslationChunk"("runLanguageId", "chapterNumber", "chunkIndex");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LlmOperation_translationRunId_idx" ON "LlmOperation"("translationRunId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "LlmOperation" ADD CONSTRAINT "LlmOperation_translationRunId_fkey" FOREIGN KEY ("translationRunId") REFERENCES "TranslationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "TranslationRun" ADD CONSTRAINT "TranslationRun_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "LlmOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "TranslationRun" ADD CONSTRAINT "TranslationRun_bookVersionId_fkey" FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
-- NO ACTION, а не RESTRICT (решение арбитра `F05 | F05-4a`, В2): удаление версии-исходника
-- каскадом уносит и досье, и запуск - RESTRICT проверяется сразу и уронил бы его.
DO $$ BEGIN
  ALTER TABLE "TranslationRun" ADD CONSTRAINT "TranslationRun_dossierId_fkey" FOREIGN KEY ("dossierId") REFERENCES "BookDossier"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "TranslationRunLanguage" ADD CONSTRAINT "TranslationRunLanguage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TranslationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
-- NO ACTION - как у досье запуска (В2).
DO $$ BEGIN
  ALTER TABLE "TranslationRunLanguage" ADD CONSTRAINT "TranslationRunLanguage_glossaryId_fkey" FOREIGN KEY ("glossaryId") REFERENCES "BookGlossary"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "TranslationChunk" ADD CONSTRAINT "TranslationChunk_runLanguageId_fkey" FOREIGN KEY ("runLanguageId") REFERENCES "TranslationRunLanguage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
