-- Варианты пересказа (F04-1, `books-app-docs/features/F04-summary-variants/tech.md` §2):
-- очень краткий пересказ колонками `BookSummary` и разделы пересказа отдельной таблицей.
-- Только добавление: прежний образ новых колонок и таблицы не знает и не трогает.
-- Откат: `DROP TABLE "BookSummarySection";` и `ALTER TABLE "BookSummary" DROP COLUMN ...` -
-- только через владельца (тема 2).
ALTER TABLE "BookSummary" ADD COLUMN IF NOT EXISTS "brief" TEXT;
ALTER TABLE "BookSummary" ADD COLUMN IF NOT EXISTS "briefHasText" BOOLEAN NOT NULL DEFAULT false;

-- Без `CHECK ("number" >= 1)`: сдвиг номеров идёт через отрицательные (T4).
CREATE TABLE IF NOT EXISTS "BookSummarySection" (
    "id" TEXT NOT NULL,
    "bookVersionId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "readerChapter" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "movedAt" TIMESTAMP(3),

    CONSTRAINT "BookSummarySection_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BookSummarySection_bookVersionId_fkey" FOREIGN KEY ("bookVersionId")
        REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "BookSummarySection_bookVersionId_number_key"
    ON "BookSummarySection"("bookVersionId", "number");
