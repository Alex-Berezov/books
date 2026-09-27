-- Решение владельца 27.09.2026 (тема №4, правовая семантика прав на книги):
--   1) «Разрешить публикацию» — последняя инстанция по правам книги, журнал решений;
--   2) правка книги после одобрения больше не блокирует публикацию;
--   3) автоматических перепроверок нет, только ручные.
-- Не разрушительная: новая таблица, новое умолчание и UPDATE статусов. Всё, что UPDATE
-- переписывает, миграция сначала кладёт в журнал: закрытие задач — строки "RightsRecheckEvent"
-- с типом DISMISSED, снятие stale — строки "RightsContentHashEvent" с reasonCode
-- OWNER_DECISION_STALE_RESET, где в reasonRu записаны прежние статус, дата и причина пометки.
--
-- Идемпотентна: частично применённую миграцию (обрыв по lock timeout между операторами) можно
-- прогнать повторно. DDL — `IF NOT EXISTS` и DO-блоки на внешние ключи; каждая запись в журнал
-- защищена `NOT EXISTS` по своей строке, а UPDATE отбирает только ещё не обработанные строки.

-- 1. Журнал решений «Разрешить публикацию».
CREATE TABLE IF NOT EXISTS "RightsPublicationOverride" (
    "id" TEXT NOT NULL,
    "bookId" TEXT,
    "bookSlug" TEXT NOT NULL,
    "reasonRu" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "revokeReasonRu" TEXT,

    CONSTRAINT "RightsPublicationOverride_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RightsPublicationOverride_bookId_revokedAt_idx" ON "RightsPublicationOverride"("bookId", "revokedAt");
CREATE INDEX IF NOT EXISTS "RightsPublicationOverride_grantedByUserId_idx" ON "RightsPublicationOverride"("grantedByUserId");
CREATE INDEX IF NOT EXISTS "RightsPublicationOverride_revokedByUserId_idx" ON "RightsPublicationOverride"("revokedByUserId");

DO $$ BEGIN
  ALTER TABLE "RightsPublicationOverride" ADD CONSTRAINT "RightsPublicationOverride_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "RightsPublicationOverride" ADD CONSTRAINT "RightsPublicationOverride_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "RightsPublicationOverride" ADD CONSTRAINT "RightsPublicationOverride_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Плановых перепроверок нет: новые профили заводятся с MANUAL_ONLY. Политику существующих
--    профилей миграция не трогает — скан задач не создаёт ни при какой политике, а явно
--    выставленные администратором FIXED_INTERVAL / PAUSED остаются как запись его решения.
ALTER TABLE "RightsProfile" ALTER COLUMN "recheckPolicy" SET DEFAULT 'MANUAL_ONLY';

-- 3. Открытые автоматические задачи перепроверки закрываются. Отбор по источнику, а не по
--    причине: ручная задача (`source = MANUAL`) может нести любую причину и остаётся открытой.
INSERT INTO "RightsRecheckEvent" ("id", "recheckTaskId", "eventType", "fromStatus", "toStatus", "messageRu", "createdAt")
SELECT gen_random_uuid()::text, t."id", 'DISMISSED', t."status", 'DISMISSED',
       'Закрыто миграцией: автоматические перепроверки отменены решением владельца 27.09.2026', NOW()
  FROM "RightsRecheckTask" t
 WHERE t."status" IN ('PENDING', 'IN_PROGRESS')
   AND t."source" <> 'MANUAL'
   AND NOT EXISTS (
     SELECT 1 FROM "RightsRecheckEvent" e
      WHERE e."recheckTaskId" = t."id"
        AND e."eventType" = 'DISMISSED'
        AND e."messageRu" = 'Закрыто миграцией: автоматические перепроверки отменены решением владельца 27.09.2026'
   );

UPDATE "RightsRecheckTask"
   SET "status" = 'DISMISSED',
       "resolution" = 'DISMISSED_NOT_APPLICABLE',
       "dismissedAt" = NOW(),
       "dismissReasonRu" = 'Автоматические перепроверки отменены решением владельца 27.09.2026',
       "updatedAt" = NOW()
 WHERE "status" IN ('PENDING', 'IN_PROGRESS')
   AND "source" <> 'MANUAL';

-- 4. Правка книги больше не аннулирует клиренс. STALE ставила только пометка по content hash
--    (`markVersionAndClearanceStale`), и ставила её только поверх утверждённой пары, поэтому
--    STALE с отметкой утверждения возвращается в утверждённое состояние — только у действующего
--    (`isCurrent`) профиля: старая пометка писала STALE и поверх SUPERSEDED-снимка версии, и
--    «воскресить» такой профиль значило бы дать интейку два утверждённых. Прочее не трогается.
--    Прежнее состояние каждой строки — в журнал до её обновления.
INSERT INTO "RightsContentHashEvent" ("id", "rightsReviewId", "trigger", "hashAlgorithmVersion", "staleMarked", "reasonCode", "reasonRu", "createdAt")
SELECT gen_random_uuid()::text, r."id", 'MANUAL_HASH_CHECK', 'OWNER_DECISION_27_09_2026', false, 'OWNER_DECISION_STALE_RESET',
       'Проверка возвращена из STALE в HUMAN_APPROVED решением владельца 27.09.2026. Было: staleDetectedAt=' ||
       COALESCE(to_char(r."staleDetectedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'), 'null') ||
       ', staleReasonCode=' || COALESCE(r."staleReasonCode", 'null') ||
       ', staleReasonRu=' || COALESCE(r."staleReasonRu", 'null'),
       NOW()
  FROM "RightsReview" r
  JOIN "RightsProfile" rp ON rp."id" = r."rightsProfileId"
 WHERE r."status" = 'STALE'
   AND r."approvedAt" IS NOT NULL
   AND rp."isCurrent" = true
   AND NOT EXISTS (
     SELECT 1 FROM "RightsContentHashEvent" he
      WHERE he."rightsReviewId" = r."id" AND he."reasonCode" = 'OWNER_DECISION_STALE_RESET'
   );

UPDATE "RightsReview"
   SET "status" = 'HUMAN_APPROVED',
       "staleDetectedAt" = NULL,
       "staleReasonCode" = NULL,
       "staleReasonRu" = NULL
 WHERE "status" = 'STALE'
   AND "approvedAt" IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM "RightsProfile" rp
      WHERE rp."id" = "RightsReview"."rightsProfileId" AND rp."isCurrent" = true
   );

INSERT INTO "RightsContentHashEvent" ("id", "rightsProfileId", "trigger", "hashAlgorithmVersion", "staleMarked", "reasonCode", "reasonRu", "createdAt")
SELECT gen_random_uuid()::text, p."id", 'MANUAL_HASH_CHECK', 'OWNER_DECISION_27_09_2026', false, 'OWNER_DECISION_STALE_RESET',
       'Профиль возвращён из STALE в APPROVED решением владельца 27.09.2026. Было: staleDetectedAt=' ||
       COALESCE(to_char(p."staleDetectedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'), 'null') ||
       ', staleReasonCode=' || COALESCE(p."staleReasonCode", 'null') ||
       ', staleReasonRu=' || COALESCE(p."staleReasonRu", 'null'),
       NOW()
  FROM "RightsProfile" p
 WHERE p."status" = 'STALE'
   AND p."isCurrent" = true
   AND EXISTS (
     SELECT 1 FROM "RightsReview" r
      WHERE r."rightsProfileId" = p."id" AND r."status" = 'HUMAN_APPROVED'
   )
   AND NOT EXISTS (
     SELECT 1 FROM "RightsContentHashEvent" he
      WHERE he."rightsProfileId" = p."id" AND he."reasonCode" = 'OWNER_DECISION_STALE_RESET'
   );

UPDATE "RightsProfile" p
   SET "status" = 'APPROVED',
       "staleDetectedAt" = NULL,
       "staleReasonCode" = NULL,
       "staleReasonRu" = NULL
 WHERE p."status" = 'STALE'
   AND p."isCurrent" = true
   AND EXISTS (
     SELECT 1 FROM "RightsReview" r
      WHERE r."rightsProfileId" = p."id" AND r."status" = 'HUMAN_APPROVED'
   );

INSERT INTO "RightsContentHashEvent" ("id", "bookVersionId", "rightsProfileId", "rightsReviewId", "trigger", "previousHash", "hashAlgorithmVersion", "staleMarked", "reasonCode", "reasonRu", "createdAt")
SELECT gen_random_uuid()::text, v."id", v."rightsProfileId", v."approvedRightsReviewId", 'MANUAL_HASH_CHECK', v."rightsContentHash",
       COALESCE(v."rightsContentHashAlgorithmVersion", 'OWNER_DECISION_27_09_2026'), false, 'OWNER_DECISION_STALE_RESET',
       'Пометка stale снята с версии решением владельца 27.09.2026. Было: rightsRecheckRequired=' ||
       v."rightsRecheckRequired"::text ||
       ', rightsStaleDetectedAt=' || COALESCE(to_char(v."rightsStaleDetectedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'), 'null') ||
       ', rightsStaleReasonCode=' || COALESCE(v."rightsStaleReasonCode", 'null') ||
       ', rightsStaleReasonRu=' || COALESCE(v."rightsStaleReasonRu", 'null'),
       NOW()
  FROM "BookVersion" v
 WHERE (v."rightsRecheckRequired" = true OR v."rightsStaleDetectedAt" IS NOT NULL)
   AND NOT EXISTS (
     SELECT 1 FROM "RightsContentHashEvent" he
      WHERE he."bookVersionId" = v."id" AND he."reasonCode" = 'OWNER_DECISION_STALE_RESET'
   );

UPDATE "BookVersion"
   SET "rightsRecheckRequired" = false,
       "rightsStaleDetectedAt" = NULL,
       "rightsStaleReasonCode" = NULL,
       "rightsStaleReasonRu" = NULL
 WHERE "rightsRecheckRequired" = true
    OR "rightsStaleDetectedAt" IS NOT NULL;
