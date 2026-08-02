-- WP-10.4 (R3-07): удаление мёртвых колонок content hash на RightsProfile и RightsReview
--
-- Миграция `20260725120000_add_rights_content_hash_stale_detection` завела на обеих моделях
-- по семь колонок. Три из них живые: `staleDetectedAt`, `staleReasonCode`, `staleReasonRu`
-- пишет `RightsContentHashService.markStale`, а `staleReasonCode` читает
-- `rights-recheck.util.ts` при выборе причины перепроверки. Эти три колонки остаются.
--
-- Оставшиеся четыре на каждой модели — `contentHash`, `contentHashAlgorithmVersion`,
-- `contentHashInput`, `contentHashCalculatedAt` — были заведены «на будущее» и за
-- восемнадцать фаз ни разу не записаны и не прочитаны: сплошной grep по `books/src`,
-- `books/test` и `books/prisma` не находит ни одного обращения к ним. Комментарий в схеме
-- честно предупреждал «NOT populated», но спасал только того, кто его прочтёт.
--
-- Причина удаления не в экономии места. Канонический хеш контента живёт на
-- `BookVersion.rightsContentHash*`; колонка `RightsProfile.contentHash` рядом с ним — ловушка
-- ровно того класса, что уронил фазу 14: читающий агент видит поле с подходящим именем на
-- центральной модели, читает его и получает `NULL`, из которого следует неверный вывод
-- «хеша нет, проверять нечего». Мёртвая колонка с правдоподобным именем опаснее её отсутствия.
--
-- Данных миграция не теряет: колонки пусты во всех строках (NULL по умолчанию, ни одной
-- записи). Индексы по `contentHash` снимаются вместе с колонками — DROP COLUMN удаляет
-- зависимые индексы сам, но снимаются они явно, чтобы миграция читалась без домысливания.
--
-- Все операторы идемпотентны: файл миграции Prisma не оборачивает в транзакцию, поэтому
-- повтор поверх частично применённого состояния должен быть безопасен.

-- DropIndex
DROP INDEX IF EXISTS "RightsProfile_contentHash_idx";
DROP INDEX IF EXISTS "RightsReview_contentHash_idx";

-- DropColumn: RightsProfile
ALTER TABLE "RightsProfile" DROP COLUMN IF EXISTS "contentHash";
ALTER TABLE "RightsProfile" DROP COLUMN IF EXISTS "contentHashAlgorithmVersion";
ALTER TABLE "RightsProfile" DROP COLUMN IF EXISTS "contentHashInput";
ALTER TABLE "RightsProfile" DROP COLUMN IF EXISTS "contentHashCalculatedAt";

-- DropColumn: RightsReview
ALTER TABLE "RightsReview" DROP COLUMN IF EXISTS "contentHash";
ALTER TABLE "RightsReview" DROP COLUMN IF EXISTS "contentHashAlgorithmVersion";
ALTER TABLE "RightsReview" DROP COLUMN IF EXISTS "contentHashInput";
ALTER TABLE "RightsReview" DROP COLUMN IF EXISTS "contentHashCalculatedAt";
