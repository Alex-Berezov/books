-- WP-9: файловое хранение системы прав (R4-02, R3-08, R3-05 / WP-8.3)
--
-- До этой миграции файлового хранения в системе прав не было вообще. Юридические отчёты жили
-- как `@db.Text` в PostgreSQL, PDF-отчёт (требование roadmap фазы 3) положить было физически
-- некуда, у исходного издания не было контрольной суммы самого файла — хешировались только
-- метаданные, поэтому подмена файла источника оставалась невидимой для клиренса, — а
-- доказательство существовало как один `url`, который завтра отдаёт 404 вместе с обоснованием
-- блокировки страны.
--
-- Миграция добавляет колонки пути и контрольной суммы четырём моделям ядра прав
-- (`RightsIntake`, `RightsReviewImport`, `SourceEdition`, `RightsEvidence`), двум колонкам
-- снимка на `RightsReview` и связи «доказательство заменено другим доказательством».
-- Сами файлы лежат в приватном хранилище прав; в базе — только ключ, сумма и сопровождение.
--
-- Новых значений в существующие enum'ы не добавляется, новых enum'ов не создаётся — пары
-- «enum → модели» миграция не требует.
--
-- Все колонки nullable либо имеют DEFAULT, поэтому бэкфилла миграция не содержит: у
-- унаследованных строк файла нет, и выдумывать ему путь или сумму нельзя. `RightsEvidence`
-- получает `isCurrent` со значением true — унаследованное доказательство действующее, пока
-- его явно не заменили.
--
-- Каждый оператор идемпотентен: миграцию можно безопасно повторить поверх частично
-- применённого состояния (Prisma не оборачивает файл миграции в одну транзакцию).

-- AlterTable: снимок манифеста, отданного агенту (essence §15 input_manifest_*)
ALTER TABLE "RightsIntake" ADD COLUMN IF NOT EXISTS "manifestStorageKey" TEXT;
ALTER TABLE "RightsIntake" ADD COLUMN IF NOT EXISTS "manifestSha256" TEXT;
ALTER TABLE "RightsIntake" ADD COLUMN IF NOT EXISTS "manifestVersion" TEXT;
ALTER TABLE "RightsIntake" ADD COLUMN IF NOT EXISTS "manifestGeneratedAt" TIMESTAMP(3);

-- AlterTable: архивные копии текстовых артефактов отчёта (essence §15 report_*_storage_key)
ALTER TABLE "RightsReviewImport" ADD COLUMN IF NOT EXISTS "reportJsonStorageKey" TEXT;
ALTER TABLE "RightsReviewImport" ADD COLUMN IF NOT EXISTS "reportMarkdownStorageKey" TEXT;
ALTER TABLE "RightsReviewImport" ADD COLUMN IF NOT EXISTS "rawAgentOutputStorageKey" TEXT;

-- AlterTable: PDF-отчёт (WP-9.2, roadmap фазы 3)
ALTER TABLE "RightsReviewImport" ADD COLUMN IF NOT EXISTS "reportPdfStorageKey" TEXT;
ALTER TABLE "RightsReviewImport" ADD COLUMN IF NOT EXISTS "reportPdfSha256" TEXT;
ALTER TABLE "RightsReviewImport" ADD COLUMN IF NOT EXISTS "reportPdfFileName" TEXT;
ALTER TABLE "RightsReviewImport" ADD COLUMN IF NOT EXISTS "reportPdfContentType" TEXT;
ALTER TABLE "RightsReviewImport" ADD COLUMN IF NOT EXISTS "reportPdfSizeBytes" INTEGER;
ALTER TABLE "RightsReviewImport" ADD COLUMN IF NOT EXISTS "reportPdfUploadedAt" TIMESTAMP(3);
ALTER TABLE "RightsReviewImport" ADD COLUMN IF NOT EXISTS "reportPdfUploadedByUserId" TEXT;

-- AlterTable: снимок задания, под которое агент писал отчёт
ALTER TABLE "RightsReviewImport" ADD COLUMN IF NOT EXISTS "inputManifestStorageKey" TEXT;
ALTER TABLE "RightsReviewImport" ADD COLUMN IF NOT EXISTS "inputManifestSha256" TEXT;
ALTER TABLE "RightsReviewImport" ADD COLUMN IF NOT EXISTS "inputManifestVersion" TEXT;
ALTER TABLE "RightsReviewImport" ADD COLUMN IF NOT EXISTS "promptVersion" TEXT;
ALTER TABLE "RightsReviewImport" ADD COLUMN IF NOT EXISTS "agentModel" TEXT;

-- AlterTable: снимок задания на самой проверке (essence §15 prompt_version / agent_model)
ALTER TABLE "RightsReview" ADD COLUMN IF NOT EXISTS "promptVersion" TEXT;
ALTER TABLE "RightsReview" ADD COLUMN IF NOT EXISTS "agentModel" TEXT;

-- AlterTable: файл исходного издания (WP-8.3, R3-05)
ALTER TABLE "SourceEdition" ADD COLUMN IF NOT EXISTS "sourceFileStorageKey" TEXT;
ALTER TABLE "SourceEdition" ADD COLUMN IF NOT EXISTS "sourceFileSha256" TEXT;
ALTER TABLE "SourceEdition" ADD COLUMN IF NOT EXISTS "sourceFileName" TEXT;
ALTER TABLE "SourceEdition" ADD COLUMN IF NOT EXISTS "sourceFileContentType" TEXT;
ALTER TABLE "SourceEdition" ADD COLUMN IF NOT EXISTS "sourceFileSizeBytes" INTEGER;
ALTER TABLE "SourceEdition" ADD COLUMN IF NOT EXISTS "sourceFileUploadedAt" TIMESTAMP(3);
ALTER TABLE "SourceEdition" ADD COLUMN IF NOT EXISTS "sourceFileUploadedByUserId" TEXT;

-- AlterTable: архивная копия доказательства и его замена (WP-9.3, R3-08)
ALTER TABLE "RightsEvidence" ADD COLUMN IF NOT EXISTS "storageKey" TEXT;
ALTER TABLE "RightsEvidence" ADD COLUMN IF NOT EXISTS "fileSha256" TEXT;
ALTER TABLE "RightsEvidence" ADD COLUMN IF NOT EXISTS "fileName" TEXT;
ALTER TABLE "RightsEvidence" ADD COLUMN IF NOT EXISTS "contentType" TEXT;
ALTER TABLE "RightsEvidence" ADD COLUMN IF NOT EXISTS "sizeBytes" INTEGER;
ALTER TABLE "RightsEvidence" ADD COLUMN IF NOT EXISTS "isArchivedCopy" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RightsEvidence" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE "RightsEvidence" ADD COLUMN IF NOT EXISTS "archivedByUserId" TEXT;
ALTER TABLE "RightsEvidence" ADD COLUMN IF NOT EXISTS "isCurrent" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "RightsEvidence" ADD COLUMN IF NOT EXISTS "supersededById" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RightsReviewImport_reportPdfSha256_idx" ON "RightsReviewImport"("reportPdfSha256");
CREATE INDEX IF NOT EXISTS "RightsReviewImport_reportPdfUploadedByUserId_idx" ON "RightsReviewImport"("reportPdfUploadedByUserId");
CREATE INDEX IF NOT EXISTS "SourceEdition_sourceFileSha256_idx" ON "SourceEdition"("sourceFileSha256");
CREATE INDEX IF NOT EXISTS "SourceEdition_sourceFileUploadedByUserId_idx" ON "SourceEdition"("sourceFileUploadedByUserId");
CREATE INDEX IF NOT EXISTS "RightsEvidence_fileSha256_idx" ON "RightsEvidence"("fileSha256");
CREATE INDEX IF NOT EXISTS "RightsEvidence_isCurrent_idx" ON "RightsEvidence"("isCurrent");
CREATE INDEX IF NOT EXISTS "RightsEvidence_archivedByUserId_idx" ON "RightsEvidence"("archivedByUserId");
CREATE UNIQUE INDEX IF NOT EXISTS "RightsEvidence_supersededById_key" ON "RightsEvidence"("supersededById");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsReviewImport_reportPdfUploadedByUserId_fkey') THEN
    ALTER TABLE "RightsReviewImport"
      ADD CONSTRAINT "RightsReviewImport_reportPdfUploadedByUserId_fkey"
      FOREIGN KEY ("reportPdfUploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SourceEdition_sourceFileUploadedByUserId_fkey') THEN
    ALTER TABLE "SourceEdition"
      ADD CONSTRAINT "SourceEdition_sourceFileUploadedByUserId_fkey"
      FOREIGN KEY ("sourceFileUploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsEvidence_archivedByUserId_fkey') THEN
    ALTER TABLE "RightsEvidence"
      ADD CONSTRAINT "RightsEvidence_archivedByUserId_fkey"
      FOREIGN KEY ("archivedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  -- Самоссылка: доказательство заменено другим доказательством. ON DELETE SET NULL — цепочка
  -- замен не должна каскадно сносить строки, которые ADR-009 запрещает удалять в принципе.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RightsEvidence_supersededById_fkey') THEN
    ALTER TABLE "RightsEvidence"
      ADD CONSTRAINT "RightsEvidence_supersededById_fkey"
      FOREIGN KEY ("supersededById") REFERENCES "RightsEvidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
