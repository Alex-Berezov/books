-- F08-1: мир книги - сущности версии (`books-app-docs/features/F08-book-wiki/tech.md` §2; решения
-- арбитра `F08 | F08-1` R1, R2 и модель без `imageMediaId`/`imageReadAt` - их добавит F08-11).
--
-- Миграция только добавляющая: новый тип, новая таблица, индексы и внешний ключ. Прежний образ этих
-- объектов не знает и не трогает. Откат: `DROP TABLE` и типа - только через владельца (тема 2),
-- если в таблице есть строки. Каждый оператор переживает повторный накат (ADR-018).

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "WorldEntityType" AS ENUM ('character', 'pair', 'place', 'object', 'term', 'event');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "BookWorldEntity" (
    "id" TEXT NOT NULL,
    "bookVersionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" "WorldEntityType" NOT NULL,
    "name" TEXT NOT NULL,
    "short" TEXT,
    "role" TEXT,
    "aliases" JSONB,
    "aliasExclusions" JSONB,
    "blocks" JSONB,
    "sources" JSONB,
    "mentions" JSONB,
    "mentionsAt" TIMESTAMP(3),
    "hasCore" BOOLEAN NOT NULL DEFAULT false,
    "coreMissing" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isListed" BOOLEAN NOT NULL DEFAULT false,
    "isVisible" BOOLEAN NOT NULL DEFAULT true,
    "isIndexable" BOOLEAN NOT NULL DEFAULT true,
    "readAt" TIMESTAMP(3),
    "autoTextAt" TIMESTAMP(3),
    "firstPublishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookWorldEntity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "BookWorldEntity_bookVersionId_key_key" ON "BookWorldEntity"("bookVersionId", "key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BookWorldEntity_bookVersionId_type_idx" ON "BookWorldEntity"("bookVersionId", "type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "BookWorldEntity_bookVersionId_isListed_idx" ON "BookWorldEntity"("bookVersionId", "isListed");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BookWorldEntity_bookVersionId_fkey') THEN
    ALTER TABLE "BookWorldEntity" ADD CONSTRAINT "BookWorldEntity_bookVersionId_fkey"
      FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
