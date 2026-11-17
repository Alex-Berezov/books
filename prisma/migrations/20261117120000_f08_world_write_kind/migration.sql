-- `F08-4a`: вид строки `ContentDraft` - ход «Write World» на версии
-- (`books-app-docs/features/F08-book-wiki/tech.md` §5). Строки этого вида пишет `F08-4a`.
--
-- Миграция только добавляющая: значение перечисления, ни `DROP`, ни сужения типа. Откат
-- образа ничего не теряет (ADR-018): прежний образ этого значения не пишет и не читает.
-- Идемпотентна (`IF NOT EXISTS`), как `20261104100000_f07_analysis_write_kind`.
-- `ADD VALUE` не переписывает таблиц и не используется в этой же миграции.

-- AlterEnum
ALTER TYPE "ContentDraftKind" ADD VALUE IF NOT EXISTS 'world_write';
