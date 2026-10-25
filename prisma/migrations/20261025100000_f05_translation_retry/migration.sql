-- F05-7v-a: повтор куска перевода своей операцией и правка куска руками (решения арбитра
-- `F05 | F05-7v`, 25.10.2026). Вид операции повтора, попытка повтора на куске (кусок
-- подменяется ею одной транзакцией с перезаписью главы), отметка правки руками и итог
-- последней перезаписи главы черновика по Р9.
--
-- Миграция только добавляющая: значение перечисления и колонки без `NOT NULL`. Откат образа
-- ничего не теряет (ADR-018): прежний образ этих колонок и значения не пишет и не читает.
-- Каждый оператор переживает повторный накат; `ADD VALUE` в этой же миграции не используется.

-- AlterEnum
ALTER TYPE "LlmOperationKind" ADD VALUE IF NOT EXISTS 'translation_retry';

-- AlterTable
ALTER TABLE "TranslationChunk" ADD COLUMN IF NOT EXISTS "retry" JSONB;
ALTER TABLE "TranslationChunk" ADD COLUMN IF NOT EXISTS "editedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TranslationChapter" ADD COLUMN IF NOT EXISTS "rewriteRefusal" TEXT;
