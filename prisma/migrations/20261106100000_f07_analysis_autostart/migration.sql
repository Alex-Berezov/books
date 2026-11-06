-- `F07-3b`: автозапуск хода «Разбор и анализ» по концу языка запуска перевода
-- (`books-app-docs/features/F07-analysis-autofill/tech.md` §6; решения арбитра `F07 | F07-3`).
--
-- Миграция только добавляющая: колонка с умолчанием, nullable-колонка и заполнение новой колонки.
-- Ни `DROP`, ни сужения типа: прежний образ этих колонок не пишет и не читает.
-- Идемпотентна (`IF NOT EXISTS`, заполняются только пустые), как `20261103120000_f06_autostart`.

-- AlterTable
ALTER TABLE "TranslationRun" ADD COLUMN IF NOT EXISTS "writeAnalysis" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "LlmOperation" ADD COLUMN IF NOT EXISTS "contentKind" "ContentDraftKind";

-- До `F07-3b` операции `draft` запуска заводил только автозапуск пересказа (`F06-5`).
-- Операции, которые прежний образ заведёт после миграции до смены образа, останутся без вида:
-- их дозаполнит повторная миграция с тем же условием в первом теге после этого (решение арбитра
-- `F07 | F07-3b`, окно выката); код `null` не толкует.
-- Откат образа по тегу: прежний образ выбирает операции строки Summary без вида и покажет в ней
-- и операции анализа запусков с обоими разделами - только показ в админке, данные и деньги не
-- задеты (решение арбитра `F07 | F07-3b`, круг /qa 2, В2).
UPDATE "LlmOperation" SET "contentKind" = 'summary_write'
WHERE "kind" = 'draft' AND "translationRunId" IS NOT NULL AND "contentKind" IS NULL;
