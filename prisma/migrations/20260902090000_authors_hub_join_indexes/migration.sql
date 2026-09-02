-- LEGACY-272. Два индекса под связь автора с книгами (`PUBLISHED_BOOKS_JOIN`
-- в `src/modules/author/author.service.ts`). Миграция только добавляющая:
-- данные не меняются, откат - `DROP INDEX IF EXISTS`.
--
-- Замер на локальной синтетике (25 000 `AuthorTranslation`, 20 000 опубликованных
-- `BookVersion`, `authorId` заполнен у четверти строк), `EXPLAIN (ANALYZE, BUFFERS)`:
--
--                          было      стало
--   страница хаба        1069 мс    0,39 мс
--   `total` страницы      905 мс      26 мс
--   счётчик по буквам     920 мс      29 мс
--
-- Без индексов планировщик соединяет таблицы по одному `language`, а половины
-- `OR` применяет фильтром соединения: 19 996 000 отброшенных строк на запрос.
-- С индексами `OR` раскладывается в `BitmapOr` двух индексных обходов, то есть
-- переписывать запрос в `UNION` (пункт 3 записи) не требуется.

-- Строковая половина `OR` (`bv.author = t.name`) вместе с обоими условиями
-- отбора версии. Несёт основную работу: в одиночку даёт 36/28/32 мс.
CREATE INDEX IF NOT EXISTS "BookVersion_author_language_status_idx"
  ON "BookVersion"("author", "language", "status");

-- Внешняя сторона join'а и порядок публичного списка. Связь сама по себе
-- не ускоряет (`total` и буквы в одиночку остаются на 906/924 мс), но отдаёт
-- `ORDER BY t.name` уже отсортированный вход: страница падает с 36 мс до 0,4 мс.
CREATE INDEX IF NOT EXISTS "AuthorTranslation_language_name_idx"
  ON "AuthorTranslation"("language", "name");
