-- Сборка перевода (F05-6, `books-app-docs/features/F05-book-translation/batches.md`): главы языка
-- запуска после сборки, ссылка языка на черновик версии, ответ этапа `metadata` и итоговая проверка.
-- Схема - целиком в подпачке 6a (решение арбитра `F05 | F05-6`); версию и главы черновика пишет 6b.
-- Только добавление: прежний образ этих объектов не знает и не трогает.
-- Откат: `DROP TABLE`, `DROP TYPE` и `DROP COLUMN` - только через владельца (тема 2), если в них есть строки.
-- Каждый оператор переживает повторный накат (ADR-018).

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "TranslationChapterStatus" AS ENUM ('pending', 'assembled', 'written', 'flagged');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AlterTable
ALTER TABLE "TranslationRunLanguage" ADD COLUMN IF NOT EXISTS "flaggedChapters" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TranslationRunLanguage" ADD COLUMN IF NOT EXISTS "bookVersionId" TEXT;
ALTER TABLE "TranslationRunLanguage" ADD COLUMN IF NOT EXISTS "metadata" JSONB;
ALTER TABLE "TranslationRunLanguage" ADD COLUMN IF NOT EXISTS "finalCheck" JSONB;

-- CreateTable
CREATE TABLE IF NOT EXISTS "TranslationChapter" (
    "id" TEXT NOT NULL,
    "runLanguageId" TEXT NOT NULL,
    "chapterNumber" INTEGER NOT NULL,
    "status" "TranslationChapterStatus" NOT NULL DEFAULT 'pending',
    "flagReason" TEXT,
    "length" INTEGER,
    "lengthLimit" INTEGER,
    "seamIndex" INTEGER,
    "findings" JSONB,
    "chapterId" TEXT,
    "writtenHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranslationChapter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TranslationRunLanguage_bookVersionId_key" ON "TranslationRunLanguage"("bookVersionId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TranslationChapter_runLanguageId_chapterNumber_key" ON "TranslationChapter"("runLanguageId", "chapterNumber");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TranslationChapter_chapterId_idx" ON "TranslationChapter"("chapterId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "TranslationRunLanguage" ADD CONSTRAINT "TranslationRunLanguage_bookVersionId_fkey" FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "TranslationChapter" ADD CONSTRAINT "TranslationChapter_runLanguageId_fkey" FOREIGN KEY ("runLanguageId") REFERENCES "TranslationRunLanguage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "TranslationChapter" ADD CONSTRAINT "TranslationChapter_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
