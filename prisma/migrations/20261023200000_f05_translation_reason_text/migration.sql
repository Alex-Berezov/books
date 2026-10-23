-- Текст отказа языка запуска перевода (F05-6, 6b; решения арбитра `F05 | F05-6`): `reason` остаётся
-- кодом (`CREATE_REJECTED`), текст сервиса, отказавшего создать черновик версии, - в `reasonText`;
-- `draftCreatedAt` - черновик создавался (удалённый не пересоздаётся, `DRAFT_DELETED`).
-- Только добавление: прежний образ колонки не знает и не трогает.
-- Откат: `DROP COLUMN` обеих колонок - только через владельца (тема 2), если в них есть строки.
-- Каждый оператор переживает повторный накат (ADR-018).

-- AlterTable
ALTER TABLE "TranslationRunLanguage" ADD COLUMN IF NOT EXISTS "reasonText" TEXT;
ALTER TABLE "TranslationRunLanguage" ADD COLUMN IF NOT EXISTS "draftCreatedAt" TIMESTAMP(3);
