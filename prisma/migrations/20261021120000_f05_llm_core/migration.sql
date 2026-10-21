-- Модуль LLM (F05-1, `books-app-docs/features/F05-book-translation/batches.md`, ADR-021):
-- настройки этапов, операции с лимитом, общий потолок расходов и журнал вызовов.
-- Только добавление: прежний образ этих таблиц не знает и не трогает.
-- Откат: `DROP TABLE "LlmCall", "LlmOperation", "LlmBudget", "LlmStageSetting";` и типов -
-- только через владельца (тема 2).
-- Каждый оператор переживает повторный накат (ADR-018): обрыв посреди выката доводится вперёд
-- тем же файлом, а не правкой на проде.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "LlmOperationKind" AS ENUM ('translation_run', 'dossier', 'compare', 'draft');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "LlmOperationStatus" AS ENUM ('active', 'paused', 'cancelled', 'done', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "LlmPauseReason" AS ENUM ('LIMIT_REACHED', 'CEILING_REACHED', 'NO_COMPLIANT_PROVIDER', 'DOSSIER_STALE', 'DOSSIER_PAUSED', 'INSUFFICIENT_FUNDS', 'STEP_FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "LlmStageSetting" (
    "id" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "fallbacks" JSONB NOT NULL DEFAULT '[]',
    "temperature" DOUBLE PRECISION,
    "maxTokens" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "maxPricePerMTok" DECIMAL(14,8),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "LlmStageSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "LlmOperation" (
    "id" TEXT NOT NULL,
    "kind" "LlmOperationKind" NOT NULL,
    "bookVersionId" TEXT,
    "limitUsd" DECIMAL(14,8) NOT NULL,
    "reservedUsd" DECIMAL(14,8) NOT NULL DEFAULT 0,
    "spentUsd" DECIMAL(14,8) NOT NULL DEFAULT 0,
    "status" "LlmOperationStatus" NOT NULL DEFAULT 'active',
    "pauseReason" "LlmPauseReason",
    "createdById" TEXT,
    "settingsSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LlmOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "LlmBudget" (
    "id" INTEGER NOT NULL,
    "ceilingUsd" DECIMAL(14,8) NOT NULL DEFAULT 100,
    "reservedUsd" DECIMAL(14,8) NOT NULL DEFAULT 0,
    "spentUsd" DECIMAL(14,8) NOT NULL DEFAULT 0,
    "defaultRunLimitUsd" DECIMAL(14,8) NOT NULL DEFAULT 10,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "LlmBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "LlmCall" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "requestedModel" TEXT NOT NULL,
    "actualModel" TEXT,
    "provider" TEXT,
    "attempt" INTEGER NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "reservedUsd" DECIMAL(14,8) NOT NULL,
    "costUsd" DECIMAL(14,8),
    "costEstimated" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMs" INTEGER,
    "errorClass" TEXT,
    "reserveReleasedAt" TIMESTAMP(3),

    CONSTRAINT "LlmCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "LlmStageSetting_stage_key" ON "LlmStageSetting"("stage");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LlmOperation_status_idx" ON "LlmOperation"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LlmOperation_bookVersionId_idx" ON "LlmOperation"("bookVersionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LlmCall_operationId_idx" ON "LlmCall"("operationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LlmCall_reserveReleasedAt_startedAt_idx" ON "LlmCall"("reserveReleasedAt", "startedAt");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "LlmStageSetting" ADD CONSTRAINT "LlmStageSetting_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "LlmOperation" ADD CONSTRAINT "LlmOperation_bookVersionId_fkey" FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "LlmOperation" ADD CONSTRAINT "LlmOperation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "LlmBudget" ADD CONSTRAINT "LlmBudget_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "LlmCall" ADD CONSTRAINT "LlmCall_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "LlmOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Единственная строка общего потолка: $100 и лимит запуска по умолчанию $10 (решения арбитра
-- `F05 | F05-1`, В1 и В4). Код её не создаёт: нет строки - вызовы отклоняются по потолку.
INSERT INTO "LlmBudget" ("id", "ceilingUsd", "reservedUsd", "spentUsd", "defaultRunLimitUsd", "updatedAt")
VALUES (1, 100, 0, 0, 10, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
