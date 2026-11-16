-- F08-3a: публичные страницы мира книги (`books-app-docs/features/F08-book-wiki/tech.md` §6;
-- решения арбитра `F08 | F08-3` Q2, Q5).
--
-- Миграция только добавляющая: колонка, перечисление, таблица, индексы и внешний ключ. Прежний образ
-- их не знает и не трогает. Каждый оператор переживает повторный накат (ADR-018).

-- AlterTable: первая глава присутствия колонкой - «впервые - глава N» в списке читателя без Json.
ALTER TABLE "BookWorldEntity" ADD COLUMN IF NOT EXISTS "mentionFirst" INTEGER;

-- Строки, посчитанные до колонки (F08-2): первая глава из уже записанного `mentions.first`.
-- Только целое число; остальное оставляет NULL, его допишет следующий пересчёт версии.
UPDATE "BookWorldEntity"
SET "mentionFirst" = ("mentions"->>'first')::INTEGER
WHERE "mentionFirst" IS NULL
  AND jsonb_typeof("mentions"->'first') = 'number'
  AND ("mentions"->>'first') ~ '^[0-9]{1,9}$';

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "WorldStatEvent" AS ENUM ('view', 'to_reader', 'to_audio', 'to_world', 'to_analysis', 'to_summary', 'engaged');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorldDailyStat" (
    "id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "bookVersionId" TEXT NOT NULL,
    "key" TEXT NOT NULL DEFAULT '',
    "event" "WorldStatEvent" NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WorldDailyStat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "WorldDailyStat_day_bookVersionId_key_event_key" ON "WorldDailyStat"("day", "bookVersionId", "key", "event");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorldDailyStat_bookVersionId_day_idx" ON "WorldDailyStat"("bookVersionId", "day");

-- CreateIndex: отчёт по всем версиям за окно дней (без `bookVersionId`).
CREATE INDEX IF NOT EXISTS "WorldDailyStat_day_idx" ON "WorldDailyStat"("day");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorldDailyStat_bookVersionId_fkey') THEN
    ALTER TABLE "WorldDailyStat" ADD CONSTRAINT "WorldDailyStat_bookVersionId_fkey"
      FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
