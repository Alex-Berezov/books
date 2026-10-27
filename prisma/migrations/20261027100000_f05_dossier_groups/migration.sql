-- Сводка досье по группам (F05-Rb, `books-app-docs/features/F05-book-translation/batches.md`):
-- результаты групп хранятся до сводки сводок, повтор шага после падения их не оплачивает.
-- Только добавление: прежний образ этой таблицы не знает и не трогает.
-- Откат: `DROP TABLE` - только через владельца (тема 2), если в таблице есть строки.
-- Каждый оператор переживает повторный накат (ADR-018).

-- CreateTable
CREATE TABLE IF NOT EXISTS "BookDossierGroup" (
    "id" TEXT NOT NULL,
    "dossierId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "groupIndex" INTEGER NOT NULL,
    "firstItem" INTEGER NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "firstChapter" INTEGER NOT NULL,
    "lastChapter" INTEGER NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "data" JSONB,
    "callId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookDossierGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "BookDossierGroup_dossierId_level_groupIndex_key" ON "BookDossierGroup"("dossierId", "level", "groupIndex");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "BookDossierGroup" ADD CONSTRAINT "BookDossierGroup_dossierId_fkey" FOREIGN KEY ("dossierId") REFERENCES "BookDossier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
