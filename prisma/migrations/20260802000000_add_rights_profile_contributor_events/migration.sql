-- WP-10.1 (R8-02, R0-01): след отвязки участника профиля прав
--
-- До этой миграции связь `RightsProfileContributor` удалялась физически и не оставляла
-- никакого следа: у лицензий и претензий отвязка хотя бы писала событие в свой журнал,
-- у участников не писалось ничего. Отвязка переводчика стирала запись «этот перевод
-- сделал этот человек» бесследно, а год смерти переводчика определяет public domain.
--
-- Решение WP-0.4 (31.07.2026): физическое удаление связей остаётся — мягкое потребовало бы
-- фильтрации во всех выборках, а забытый фильтр вернул бы «удалённую» связь в гейт или
-- в расчёт покрытия лицензий. Взамен каждая привязка и каждая отвязка пишет неудаляемое
-- событие в той же транзакции, что и сама связь.
--
-- Переиспользовать существующий журнал было нечего: `RightsLicenseEvent` и `RightsClaimEvent`
-- привязаны к своим сущностям, а `RightsContentHashEvent` — журнал устаревания хеша, который
-- пишется только по версиям книги и потому молчит, пока книга из клиренса ещё не создана.
--
-- Новых значений в существующие enum'ы миграция не добавляет, поэтому разделять её на пару
-- «enum → модели» не требуется: `RightsProfileContributorEventType` создаётся здесь же и
-- используется только таблицей, создаваемой ниже в этом же файле.
--
-- Каждый оператор защищён guard'ом, чтобы миграцию можно было безопасно повторить поверх
-- частично применённого состояния (Prisma не оборачивает файл миграции в одну транзакцию).

-- CreateEnum
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RightsProfileContributorEventType') THEN
    CREATE TYPE "RightsProfileContributorEventType" AS ENUM ('LINKED', 'UNLINKED');
  END IF;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "RightsProfileContributorEvent" (
    "id" TEXT NOT NULL,
    "rightsProfileId" TEXT NOT NULL,
    "rightsProfileContributorId" TEXT NOT NULL,
    "rightsComponentId" TEXT,
    "sourceEditionId" TEXT,
    "personId" TEXT,
    "eventType" "RightsProfileContributorEventType" NOT NULL,
    "role" "ContributorRole",
    "displayName" TEXT,
    "creditedName" TEXT,
    "payload" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RightsProfileContributorEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RightsProfileContributorEvent_rightsProfileId_idx" ON "RightsProfileContributorEvent"("rightsProfileId");
CREATE INDEX IF NOT EXISTS "RightsProfileContributorEvent_rightsProfileContributorId_idx" ON "RightsProfileContributorEvent"("rightsProfileContributorId");
CREATE INDEX IF NOT EXISTS "RightsProfileContributorEvent_rightsComponentId_idx" ON "RightsProfileContributorEvent"("rightsComponentId");
CREATE INDEX IF NOT EXISTS "RightsProfileContributorEvent_sourceEditionId_idx" ON "RightsProfileContributorEvent"("sourceEditionId");
CREATE INDEX IF NOT EXISTS "RightsProfileContributorEvent_personId_idx" ON "RightsProfileContributorEvent"("personId");
CREATE INDEX IF NOT EXISTS "RightsProfileContributorEvent_eventType_idx" ON "RightsProfileContributorEvent"("eventType");
CREATE INDEX IF NOT EXISTS "RightsProfileContributorEvent_createdAt_idx" ON "RightsProfileContributorEvent"("createdAt");
CREATE INDEX IF NOT EXISTS "RightsProfileContributorEvent_createdByUserId_idx" ON "RightsProfileContributorEvent"("createdByUserId");

-- AddForeignKey
-- Только два внешних ключа. `rightsProfileContributorId`, `personId` и `sourceEditionId`
-- остаются идентификаторами без FK: строка связи к моменту чтения журнала уже удалена,
-- а FK с каскадом снёс бы вместе с ней и запись о том, что связь существовала.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsProfileContributorEvent_rightsProfileId_fkey') THEN
    ALTER TABLE "RightsProfileContributorEvent" ADD CONSTRAINT "RightsProfileContributorEvent_rightsProfileId_fkey" FOREIGN KEY ("rightsProfileId") REFERENCES "RightsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsProfileContributorEvent_createdByUserId_fkey') THEN
    ALTER TABLE "RightsProfileContributorEvent" ADD CONSTRAINT "RightsProfileContributorEvent_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
