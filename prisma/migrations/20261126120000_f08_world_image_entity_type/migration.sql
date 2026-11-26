-- `F08-12c-2`: тип сущности у строки картинки мира (решение арбитра `F08 | F08-12c-2`). Ключ картинки один
-- на книгу (`@@unique([bookId, key])` не меняется), а тип сущности у версий может разойтись: картинка видна
-- и пишется только при совпадении типа строки с типом сущности своей версии.
--
-- Миграция только добавляющая: NOT NULL с DEFAULT - прежние строки (только портреты героев) получают
-- 'character' самим default. Прежний образ колонку не читает, его INSERT заполняет её default.
-- Идемпотентна (`IF NOT EXISTS`), как `20261124120000_f08_world_place_geo`.
ALTER TABLE "BookWorldImage" ADD COLUMN IF NOT EXISTS "entityType" "WorldEntityType" NOT NULL DEFAULT 'character';
