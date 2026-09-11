-- `LEGACY-015`, пачка `M5`: журнал административных действий.
--
-- Миграция только создающая: ни `DROP`, ни `RENAME`, ни сужения типа. Старый образ
-- о таблице не знает и в неё не пишет, поэтому откат образа теряет только новые строки
-- (ADR-018).
--
-- Идемпотентна намеренно; форма повторяет `20260801000000_add_rights_action_lifecycle`.
-- Оборванный накат — упавшее соединение, таймаут, отказ соседней миграции того же релиза —
-- иначе оставил бы строку failed в `_prisma_migrations` и заблокировал все последующие
-- миграции до ручного `migrate resolve` на боевой машине, то есть до владельца.

-- CreateEnum
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AdminAuditAction') THEN
    CREATE TYPE "AdminAuditAction" AS ENUM ('ROLE_ASSIGNED', 'ROLE_REVOKED');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AdminAuditTargetType') THEN
    CREATE TYPE "AdminAuditTargetType" AS ENUM ('USER');
  END IF;
END $$;

-- CreateTable
--
-- Внешних ключей нет ни у `actorUserId`, ни у `targetId`. `DELETE /users/:id` удаляет
-- пользователя жёстко, и `ON DELETE SET NULL` обнулил бы актёра во всех его строках:
-- администратор стирал бы ответ на вопрос «кто» одним разрешённым запросом.
CREATE TABLE IF NOT EXISTS "AdminAuditEvent" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" "AdminAuditAction" NOT NULL,
    "targetType" "AdminAuditTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
--
-- Составной `(targetType, targetId, createdAt)` вместо одиночного по `targetId`: в колонке
-- лежат идентификаторы разных сущностей, а единственный осмысленный запрос к журналу —
-- «что делали с этим объектом, свежие сверху». Индекса по `action` нет намеренно:
-- на перечислении из двух значений планировщик его не возьмёт, а вставка платила бы за него.
CREATE INDEX IF NOT EXISTS "AdminAuditEvent_targetType_targetId_createdAt_idx" ON "AdminAuditEvent"("targetType", "targetId", "createdAt");
CREATE INDEX IF NOT EXISTS "AdminAuditEvent_createdAt_idx" ON "AdminAuditEvent"("createdAt");
CREATE INDEX IF NOT EXISTS "AdminAuditEvent_actorUserId_idx" ON "AdminAuditEvent"("actorUserId");
