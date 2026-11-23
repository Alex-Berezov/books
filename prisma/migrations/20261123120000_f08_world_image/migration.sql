-- `F08-11a`: иллюстрация сущности мира книги (`books-app-docs/features/F08-book-wiki/tech.md` §10;
-- решение арбитра `F08 | F08-11` Р2, Р3): таблица на книгу и ключ сущности, принятая и ожидающая ячейки.
--
-- Миграция только добавляющая: новая таблица, индексы и внешние ключи. Ни `DROP`, ни сужения типа:
-- прежний образ таблицу не читает. Идемпотентна (`IF NOT EXISTS`), как `20261122120000_f08_world_autostart`.

-- CreateTable
CREATE TABLE IF NOT EXISTS "BookWorldImage" (
    "id" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "imageMediaId" TEXT,
    "imageReadAt" TIMESTAMP(3),
    "pendingMediaId" TEXT,
    "operationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookWorldImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "BookWorldImage_bookId_key_key" ON "BookWorldImage"("bookId", "key");
CREATE INDEX IF NOT EXISTS "BookWorldImage_imageMediaId_idx" ON "BookWorldImage"("imageMediaId");
CREATE INDEX IF NOT EXISTS "BookWorldImage_pendingMediaId_idx" ON "BookWorldImage"("pendingMediaId");
CREATE INDEX IF NOT EXISTS "BookWorldImage_operationId_idx" ON "BookWorldImage"("operationId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "BookWorldImage" ADD CONSTRAINT "BookWorldImage_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BookWorldImage" ADD CONSTRAINT "BookWorldImage_imageMediaId_fkey" FOREIGN KEY ("imageMediaId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BookWorldImage" ADD CONSTRAINT "BookWorldImage_pendingMediaId_fkey" FOREIGN KEY ("pendingMediaId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BookWorldImage" ADD CONSTRAINT "BookWorldImage_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "LlmOperation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
