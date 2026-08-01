-- WP-7: языковое измерение модели прав (R2-01, R3-01, R4-03, R7-01)
--
-- До этой миграции `EditionRights` была 1:1-довеском к `SourceEdition`: языка она не несла,
-- а её `status`/`notesRu` дословно повторяли поля источника. Права по языкам агент присылал
-- в блоке `languageAssessments`, сервер проверял покрытие каждого целевого языка — и результат
-- выбрасывался, потому что записывать его было некуда.
--
-- Миграция превращает `EditionRights` в запись на язык и добавляет `RightsComponent.languageCode`
-- (nullable, `null` = «компонент общий для всех языков версии»).
--
-- Новых значений в существующие enum'ы не добавляется, новых enum'ов не создаётся — пары
-- «enum → модели» миграция не требует.
--
-- Каждый оператор идемпотентен: миграцию можно безопасно повторить поверх частично
-- применённого состояния (Prisma не оборачивает файл миграции в одну транзакцию).

-- AlterTable
ALTER TABLE "EditionRights" ADD COLUMN IF NOT EXISTS "languageCode" TEXT;
ALTER TABLE "EditionRights" ADD COLUMN IF NOT EXISTS "translationOrigin" TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "EditionRights" ADD COLUMN IF NOT EXISTS "translationSourceLanguage" TEXT;
ALTER TABLE "EditionRights" ADD COLUMN IF NOT EXISTS "requiresGeoBlock" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: существующая строка получает первый целевой язык интейка.
-- Порядок цепочки: EditionRights -> SourceEdition -> RightsProfile -> RightsIntake.targetLanguages.
-- Если целевых языков нет (интейк не заполнен) — берём язык источника, иначе 'und'
-- (ISO 639-2 «язык не определён»): выдумывать конкретный язык для унаследованной строки нельзя,
-- она и так была копией статуса источника и языка никогда не несла.
UPDATE "EditionRights" er
SET "languageCode" = COALESCE(
  (
    SELECT lang.value
    FROM "SourceEdition" se
    JOIN "RightsProfile" rp ON rp."id" = se."rightsProfileId"
    JOIN "RightsIntake" ri ON ri."id" = rp."rightsIntakeId"
    CROSS JOIN LATERAL jsonb_array_elements_text(ri."targetLanguages") WITH ORDINALITY AS lang(value, ord)
    WHERE se."id" = er."sourceEditionId"
    ORDER BY lang.ord
    LIMIT 1
  ),
  (SELECT se."sourceLanguage" FROM "SourceEdition" se WHERE se."id" = er."sourceEditionId"),
  'und'
)
WHERE er."languageCode" IS NULL;

-- AlterColumn
ALTER TABLE "EditionRights" ALTER COLUMN "languageCode" SET NOT NULL;

-- DropIndex: одна запись прав на исходное издание больше не единственно возможная
DROP INDEX IF EXISTS "EditionRights_sourceEditionId_key";

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "EditionRights_sourceEditionId_languageCode_key" ON "EditionRights"("sourceEditionId", "languageCode");
CREATE INDEX IF NOT EXISTS "EditionRights_languageCode_idx" ON "EditionRights"("languageCode");

-- Backfill: остальные целевые языки интейка получают собственную строку — копию унаследованного
-- вердикта. Это не новая информация, а перенос того, что было: настоящие языковые вердикты
-- появятся при следующей материализации отчёта.
INSERT INTO "EditionRights" (
  "id", "sourceEditionId", "languageCode", "status", "notesRu", "legalBasisRu",
  "translationOrigin", "translationSourceLanguage", "requiresGeoBlock", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  er."sourceEditionId",
  lang.value,
  er."status",
  er."notesRu",
  er."legalBasisRu",
  'UNKNOWN',
  NULL,
  false,
  er."createdAt",
  er."updatedAt"
FROM "EditionRights" er
JOIN "SourceEdition" se ON se."id" = er."sourceEditionId"
JOIN "RightsProfile" rp ON rp."id" = se."rightsProfileId"
JOIN "RightsIntake" ri ON ri."id" = rp."rightsIntakeId"
CROSS JOIN LATERAL jsonb_array_elements_text(ri."targetLanguages") AS lang(value)
WHERE lang.value <> er."languageCode"
ON CONFLICT ("sourceEditionId", "languageCode") DO NOTHING;

-- AlterTable
ALTER TABLE "RightsComponent" ADD COLUMN IF NOT EXISTS "languageCode" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RightsComponent_languageCode_idx" ON "RightsComponent"("languageCode");
