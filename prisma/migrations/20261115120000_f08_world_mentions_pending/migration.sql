-- F08-2: очередь пересчёта присутствия мира книги (`books-app-docs/features/F08-book-wiki/tech.md` §4;
-- решение арбитра `F08 | F08-2` Q1): строка на версию, `dirtyAt` - время последней правки глав
-- или форм имени, `generation` - номер постановки из последовательности (снимается строка только с взятым).
--
-- Миграция только добавляющая: новая колонка, новая таблица, индекс и внешний ключ. Прежний образ таблицу не знает
-- и не трогает. Каждый оператор переживает повторный накат (ADR-018).

-- AlterTable: число глав присутствия колонкой - его читает список редактора без Json-колонок.
ALTER TABLE "BookWorldEntity" ADD COLUMN IF NOT EXISTS "mentionChapters" INTEGER;

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorldMentionsPending" (
    "bookVersionId" TEXT NOT NULL,
    "dirtyAt" TIMESTAMP(3) NOT NULL,
    "generation" SERIAL NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WorldMentionsPending_pkey" PRIMARY KEY ("bookVersionId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorldMentionsPending_dirtyAt_idx" ON "WorldMentionsPending"("dirtyAt");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorldMentionsPending_bookVersionId_fkey') THEN
    ALTER TABLE "WorldMentionsPending" ADD CONSTRAINT "WorldMentionsPending_bookVersionId_fkey"
      FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Версии, у которых сущности мира уже есть (F08-1, присутствие не посчитано), - в очередь пересчёта
-- (решение арбитра `F08 | F08-2` R5). Только добавляет строки; повторный накат - ON CONFLICT.
INSERT INTO "WorldMentionsPending" ("bookVersionId", "dirtyAt")
SELECT DISTINCT "bookVersionId", (now() AT TIME ZONE 'UTC') FROM "BookWorldEntity"
ON CONFLICT ("bookVersionId") DO NOTHING;
