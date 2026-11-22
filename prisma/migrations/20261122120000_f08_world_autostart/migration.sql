-- `F08-9b`: автозапуск хода «Write World» по концу языка запуска перевода, после хода анализа
-- (`books-app-docs/features/F08-book-wiki/tech.md` §5; решение арбитра `F08 | F08-9b`).
--
-- Миграция только добавляющая: колонка с умолчанием. Ни `DROP`, ни сужения типа: прежний образ
-- колонки не пишет и не читает. Идемпотентна (`IF NOT EXISTS`), как `20261106100000_f07_analysis_autostart`.

-- AlterTable
ALTER TABLE "TranslationRun" ADD COLUMN IF NOT EXISTS "writeWorld" BOOLEAN NOT NULL DEFAULT false;
