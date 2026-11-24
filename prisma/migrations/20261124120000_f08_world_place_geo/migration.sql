-- `F08-12a`: точка реального места мира книги из Wikidata P625 (`books-app-docs/features/F08-book-wiki/tech.md` §11;
-- решение арбитра `F08 | F08-12` Q2). Пишет только сервер (`WorldGeoService`) после проверки ответа Wikidata.
--
-- Миграция только добавляющая: nullable-колонка без default. Прежний образ колонку не читает.
-- Идемпотентна (`IF NOT EXISTS`), как `20261123120000_f08_world_image`.
ALTER TABLE "BookWorldEntity" ADD COLUMN IF NOT EXISTS "geo" JSONB;
