-- Вызовы моделей `:batch` через Batch API OpenRouter (дело 2026-11-14-llm-batch-models).
-- Только добавление: пустые колонки ничего не ломают у синхронных вызовов.
-- Идемпотентно (X01): выкат, оборванный посередине, накатывается повторно.
ALTER TABLE "LlmCall" ADD COLUMN IF NOT EXISTS "batchId" TEXT;
ALTER TABLE "LlmCall" ADD COLUMN IF NOT EXISTS "batchKey" TEXT;
ALTER TABLE "LlmCall" ADD COLUMN IF NOT EXISTS "batchStatus" TEXT;
ALTER TABLE "LlmCall" ADD COLUMN IF NOT EXISTS "batchPolledAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "LlmCall_operationId_batchKey_idx" ON "LlmCall"("operationId", "batchKey");
CREATE INDEX IF NOT EXISTS "LlmCall_batchId_idx" ON "LlmCall"("batchId");
