-- Повтор бэкфилла `T184` (хвост захода `T184`, `tech-debt-journal.md`, выкатывается тегом `T193`):
-- между миграцией `20261112100000_t184_auto_text_read` и сменой образа прежний образ мог записать
-- текст модели без времени вклада (окно выката, как `F07-3c`). Тот же SQL, только пустые
-- (`IS NULL`), уже заполненное и отметки «прочитано» не трогаются. Миграция только добавляющая
-- и идемпотентная, e2e гоняет оба файла одним сценарием (`book-version-publish-gate.e2e-spec.ts`).

-- Бэкфилл факта «текст модели лёг в поля»: время последней правки хода любого статуса, в котором
-- хоть один элемент записан или принят. Отметку «прочитано» не ставит никому: её не было.
-- `items` не массив - пустой массив внутри `CASE`: порядок вычисления `AND` Postgres не обещает.
-- Опубликованные версии с публикации не снимаются (ADR-008): требование действует при повторной.
UPDATE "BookVersion" v SET "summaryAutoTextAt" = d."at"
FROM (
  SELECT "bookVersionId", MAX("updatedAt") AS "at" FROM "ContentDraft"
  WHERE "kind" = 'summary_write'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof("data"->'items') = 'array' THEN "data"->'items' ELSE '[]'::jsonb END
      ) e
      WHERE e->>'outcome' IN ('written', 'accepted')
    )
  GROUP BY "bookVersionId"
) d
WHERE v."id" = d."bookVersionId" AND v."summaryAutoTextAt" IS NULL;

UPDATE "BookVersion" v SET "analysisAutoTextAt" = d."at"
FROM (
  SELECT "bookVersionId", MAX("updatedAt") AS "at" FROM "ContentDraft"
  WHERE "kind" = 'analysis_write'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof("data"->'items') = 'array' THEN "data"->'items' ELSE '[]'::jsonb END
      ) e
      WHERE e->>'outcome' IN ('written', 'accepted')
    )
  GROUP BY "bookVersionId"
) d
WHERE v."id" = d."bookVersionId" AND v."analysisAutoTextAt" IS NULL;
