-- Раздел «Разбор и анализ» (F03-1, `books-app-docs/features/F03-book-analysis/tech.md` §2;
-- хранение колонками - решение арбитра А2 в decisions-log.md, метка F03 | F03-1).
-- Только добавление: новая таблица, прежний образ её не знает и не трогает.
-- Откат: `DROP TABLE "BookAnalysis";` - только через владельца (тема 2).
CREATE TABLE IF NOT EXISTS "BookAnalysis" (
    "id" TEXT NOT NULL,
    "bookVersionId" TEXT NOT NULL,
    "hasCore" BOOLEAN NOT NULL DEFAULT false,
    "facts" JSONB,
    "mainIdea" TEXT,
    "themes" JSONB,
    "characters" JSONB,
    "symbols" JSONB,
    "keyQuotes" JSONB,
    "titleMeaning" TEXT,
    "endingMeaning" TEXT,
    "context" TEXT,
    "timeline" JSONB,
    "style" JSONB,
    "reception" TEXT,
    "adaptations" JSONB,
    "misreadings" JSONB,
    "discussionQuestions" JSONB,
    "faq" JSONB,
    "sources" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookAnalysis_pkey" PRIMARY KEY ("id"),
    -- Внешний ключ внутри `CREATE TABLE`: повторный прогон с `IF NOT EXISTS` не упадёт на нём.
    CONSTRAINT "BookAnalysis_bookVersionId_fkey" FOREIGN KEY ("bookVersionId")
        REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "BookAnalysis_bookVersionId_key" ON "BookAnalysis"("bookVersionId");

