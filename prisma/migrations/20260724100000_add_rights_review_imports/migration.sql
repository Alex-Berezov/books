-- CreateEnum
CREATE TYPE "RightsReviewImportStatus" AS ENUM ('VALIDATED', 'VALIDATION_FAILED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "rights_review_imports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "rights_intake_id" UUID NOT NULL,
    "schema_version" TEXT,
    "import_status" "RightsReviewImportStatus" NOT NULL DEFAULT 'VALIDATION_FAILED',
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "report_json" JSONB NOT NULL,
    "report_markdown" TEXT,
    "raw_agent_output" TEXT,
    "source_file_name" TEXT,
    "report_json_sha256" TEXT,
    "report_markdown_sha256" TEXT,
    "raw_agent_output_sha256" TEXT,
    "validation_errors" JSONB,
    "validation_warnings" JSONB,
    "imported_by_user_id" UUID,
    "superseded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rights_review_imports_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "rights_review_imports" ADD CONSTRAINT "rights_review_imports_rights_intake_id_fkey" FOREIGN KEY ("rights_intake_id") REFERENCES "rights_intakes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rights_review_imports" ADD CONSTRAINT "rights_review_imports_imported_by_user_id_fkey" FOREIGN KEY ("imported_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "rights_review_imports_rights_intake_id_idx" ON "rights_review_imports"("rights_intake_id");
CREATE INDEX "rights_review_imports_import_status_idx" ON "rights_review_imports"("import_status");
CREATE INDEX "rights_review_imports_is_current_idx" ON "rights_review_imports"("is_current");
CREATE INDEX "rights_review_imports_created_at_idx" ON "rights_review_imports"("created_at");
CREATE INDEX "rights_review_imports_imported_by_user_id_idx" ON "rights_review_imports"("imported_by_user_id");