-- WP-5: RightsAction lifecycle
-- Добавляет полям действия жизненный цикл (назначение, срок, закрытие) и таблицу
-- неудаляемых событий RightsActionEvent с новым enum'ом RightsActionEventType.
--
-- До этой миграции RightsAction.status записывался один раз при материализации отчёта
-- и не изменялся нигде: блокирующее действие мог закрыть только агент своим отчётом,
-- человек — никогда (R3-02, R3-03).
--
-- Каждый оператор защищён guard'ом, чтобы миграцию можно было безопасно повторить
-- поверх частично применённого состояния (Prisma не оборачивает файл миграции
-- в одну транзакцию).
--
-- Новых значений в существующие enum'ы миграция не добавляет, поэтому разделять её
-- на пару «enum → модели» не требуется: RightsActionEventType создаётся здесь же и
-- используется только таблицей, создаваемой ниже в этом же файле.

-- CreateEnum
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsActionEventType') THEN
    CREATE TYPE "RightsActionEventType" AS ENUM ('STATUS_CHANGED', 'ASSIGNED', 'UNASSIGNED', 'DUE_DATE_CHANGED', 'NOTE_ADDED');
  END IF;
END $$;

-- AlterTable
ALTER TABLE "RightsAction" ADD COLUMN IF NOT EXISTS "assignedToUserId" TEXT;
ALTER TABLE "RightsAction" ADD COLUMN IF NOT EXISTS "dueAt" TIMESTAMP(3);
ALTER TABLE "RightsAction" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);
ALTER TABLE "RightsAction" ADD COLUMN IF NOT EXISTS "completedByUserId" TEXT;
ALTER TABLE "RightsAction" ADD COLUMN IF NOT EXISTS "completionNotesRu" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RightsAction_assignedToUserId_idx" ON "RightsAction"("assignedToUserId");
CREATE INDEX IF NOT EXISTS "RightsAction_completedByUserId_idx" ON "RightsAction"("completedByUserId");
CREATE INDEX IF NOT EXISTS "RightsAction_dueAt_idx" ON "RightsAction"("dueAt");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsAction_assignedToUserId_fkey') THEN
    ALTER TABLE "RightsAction" ADD CONSTRAINT "RightsAction_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsAction_completedByUserId_fkey') THEN
    ALTER TABLE "RightsAction" ADD CONSTRAINT "RightsAction_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "RightsActionEvent" (
    "id" TEXT NOT NULL,
    "rightsActionId" TEXT NOT NULL,
    "eventType" "RightsActionEventType" NOT NULL,
    "fromStatus" "RightsActionStatus",
    "toStatus" "RightsActionStatus",
    "notesRu" TEXT,
    "payload" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RightsActionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RightsActionEvent_rightsActionId_idx" ON "RightsActionEvent"("rightsActionId");
CREATE INDEX IF NOT EXISTS "RightsActionEvent_eventType_idx" ON "RightsActionEvent"("eventType");
CREATE INDEX IF NOT EXISTS "RightsActionEvent_createdAt_idx" ON "RightsActionEvent"("createdAt");
CREATE INDEX IF NOT EXISTS "RightsActionEvent_createdByUserId_idx" ON "RightsActionEvent"("createdByUserId");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsActionEvent_rightsActionId_fkey') THEN
    ALTER TABLE "RightsActionEvent" ADD CONSTRAINT "RightsActionEvent_rightsActionId_fkey" FOREIGN KEY ("rightsActionId") REFERENCES "RightsAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsActionEvent_createdByUserId_fkey') THEN
    ALTER TABLE "RightsActionEvent" ADD CONSTRAINT "RightsActionEvent_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
