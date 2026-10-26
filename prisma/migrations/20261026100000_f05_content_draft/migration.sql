-- Заготовки пересказа из досье (F05-10, `books-app-docs/features/F05-book-translation/batches.md`):
-- черновик для формы вкладки Summary, в `BookSummary` и `BookSummarySection` не пишется.
-- Только добавление: прежний образ этих объектов не знает и не трогает.
-- Откат: `DROP TABLE` и типов - только через владельца (тема 2), если в таблице есть строки.
-- Каждый оператор переживает повторный накат (ADR-018).

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ContentDraftKind" AS ENUM ('summary_sections', 'summary_full', 'summary_brief', 'analysis');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ContentDraftStatus" AS ENUM ('building', 'ready', 'failed', 'discarded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "ContentDraft" (
    "id" TEXT NOT NULL,
    "bookVersionId" TEXT NOT NULL,
    "kind" "ContentDraftKind" NOT NULL,
    "status" "ContentDraftStatus" NOT NULL DEFAULT 'building',
    "language" "Language" NOT NULL,
    "operationId" TEXT NOT NULL,
    "data" JSONB,
    "model" TEXT,
    "failedReason" TEXT,
    "dossierId" TEXT,
    "glossaryId" TEXT,
    "waitingFor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ContentDraft_operationId_key" ON "ContentDraft"("operationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ContentDraft_bookVersionId_kind_createdAt_idx" ON "ContentDraft"("bookVersionId", "kind", "createdAt");

-- Одна строящаяся заготовка на пару (версия, вид) (решение арбитра `F05 | F05-10`, В7): частичный
-- индекс Prisma описать не умеет, в схеме он объявлен комментарием `drift-check: sql-only index`.
CREATE UNIQUE INDEX IF NOT EXISTS "ContentDraft_building_key" ON "ContentDraft"("bookVersionId", "kind")
WHERE "status" = 'building';

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ContentDraft" ADD CONSTRAINT "ContentDraft_bookVersionId_fkey" FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ContentDraft" ADD CONSTRAINT "ContentDraft_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "LlmOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
