-- Фоновый исполнитель LLM на Postgres (F05-1w, `books-app-docs/features/F05-book-translation/batches.md`,
-- ADR-021): задачи с арендой и токеном владельца, ссылка вызова на задачу.
-- Только добавление: прежний образ этих объектов не знает и не трогает.
-- Откат: `DROP TABLE "LlmTask"`, колонки `LlmCall.taskId` и типа - только через владельца (тема 2).
-- Каждый оператор переживает повторный накат (ADR-018).

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "LlmTaskStatus" AS ENUM ('pending', 'running', 'done', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "LlmTask" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "bookVersionId" TEXT,
    "language" "Language",
    "chunkId" TEXT,
    "status" "LlmTaskStatus" NOT NULL DEFAULT 'pending',
    "leaseUntil" TIMESTAMP(3),
    "ownerToken" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "pairKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LlmTask_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "LlmCall" ADD COLUMN IF NOT EXISTS "taskId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LlmTask_status_runAfter_idx" ON "LlmTask"("status", "runAfter");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LlmTask_operationId_idx" ON "LlmTask"("operationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LlmTask_bookVersionId_idx" ON "LlmTask"("bookVersionId");

-- Одна незавершённая задача на пару «запуск, язык» (Р1, Р19): частичный индекс Prisma описать
-- не умеет, в схеме он объявлен комментарием `drift-check: sql-only index`.
CREATE UNIQUE INDEX IF NOT EXISTS "LlmTask_pairKey_active_key" ON "LlmTask"("pairKey")
WHERE "status" IN ('pending', 'running');

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LlmCall_taskId_idx" ON "LlmCall"("taskId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "LlmTask" ADD CONSTRAINT "LlmTask_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "LlmOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "LlmTask" ADD CONSTRAINT "LlmTask_bookVersionId_fkey" FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "LlmCall" ADD CONSTRAINT "LlmCall_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "LlmTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
