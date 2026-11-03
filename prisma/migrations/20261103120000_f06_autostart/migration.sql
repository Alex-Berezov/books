-- `F06-5`: автозапуск хода раздела «Краткий пересказ» по концу языка запуска перевода
-- (`books-app-docs/features/F06-summary-autofill/tech.md` §4; решения арбитра `F06 | F06-5`).
--
-- Миграция только добавляющая: две колонки с умолчанием или NULL, одна nullable-ссылка, её индекс
-- и внешний ключ. Ни `DROP`, ни сужения типа: прежний образ этих колонок не пишет и не читает.
-- Идемпотентна (`IF NOT EXISTS`), как `20261102100000_f06_summary_write_kind`.

-- AlterTable
ALTER TABLE "TranslationRun" ADD COLUMN IF NOT EXISTS "writeSummary" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "LlmOperation" ADD COLUMN IF NOT EXISTS "skipReason" TEXT;

-- AlterTable
ALTER TABLE "ContentDraft" ADD COLUMN IF NOT EXISTS "translationRunLanguageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ContentDraft_translationRunLanguageId_kind_key" ON "ContentDraft"("translationRunLanguageId", "kind");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ContentDraft_translationRunLanguageId_fkey'
  ) THEN
    ALTER TABLE "ContentDraft" ADD CONSTRAINT "ContentDraft_translationRunLanguageId_fkey"
      FOREIGN KEY ("translationRunLanguageId") REFERENCES "TranslationRunLanguage"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
