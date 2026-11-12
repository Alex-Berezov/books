-- `T184`: отметка редактора «прочитано» перед публикацией автотекста (слово владельца
-- 09.11.2026; решение арбитра 12.11.2026 `T184 | LEGACY-493 | LEGACY-495`, `decisions-log.md`).
--
-- Миграция только добавляющая: nullable-колонки, индексы, внешние ключи и заполнение новых колонок.
-- Ни `DROP`, ни сужения типа: прежний образ этих колонок не пишет и не читает.
-- Идемпотентна (`IF NOT EXISTS`, заполняются только пустые), как `20261106100000_f07_analysis_autostart`.

-- AlterTable
ALTER TABLE "BookVersion" ADD COLUMN IF NOT EXISTS "summaryAutoTextAt" TIMESTAMP(3);
ALTER TABLE "BookVersion" ADD COLUMN IF NOT EXISTS "summaryReadAt" TIMESTAMP(3);
ALTER TABLE "BookVersion" ADD COLUMN IF NOT EXISTS "summaryReadById" TEXT;
ALTER TABLE "BookVersion" ADD COLUMN IF NOT EXISTS "analysisAutoTextAt" TIMESTAMP(3);
ALTER TABLE "BookVersion" ADD COLUMN IF NOT EXISTS "analysisReadAt" TIMESTAMP(3);
ALTER TABLE "BookVersion" ADD COLUMN IF NOT EXISTS "analysisReadById" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BookVersion_summaryReadById_idx" ON "BookVersion"("summaryReadById");
CREATE INDEX IF NOT EXISTS "BookVersion_analysisReadById_idx" ON "BookVersion"("analysisReadById");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BookVersion_summaryReadById_fkey') THEN
    ALTER TABLE "BookVersion" ADD CONSTRAINT "BookVersion_summaryReadById_fkey"
      FOREIGN KEY ("summaryReadById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BookVersion_analysisReadById_fkey') THEN
    ALTER TABLE "BookVersion" ADD CONSTRAINT "BookVersion_analysisReadById_fkey"
      FOREIGN KEY ("analysisReadById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

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
