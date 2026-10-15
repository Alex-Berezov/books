-- F02-2: данные новой страницы автора. Только добавление. Колонки блоков — без умолчаний и без
-- NOT NULL: существующие строки получают NULL = «блока нет» (books-app-docs/features/F02-author-page/tech.md §2).
ALTER TABLE "Author" ADD COLUMN IF NOT EXISTS "nativeName" TEXT;
ALTER TABLE "Author" ADD COLUMN IF NOT EXISTS "photoCredit" JSONB;

ALTER TABLE "AuthorTranslation" ADD COLUMN IF NOT EXISTS "tagline" TEXT;
ALTER TABLE "AuthorTranslation" ADD COLUMN IF NOT EXISTS "facts" JSONB;
ALTER TABLE "AuthorTranslation" ADD COLUMN IF NOT EXISTS "notableWorks" JSONB;
ALTER TABLE "AuthorTranslation" ADD COLUMN IF NOT EXISTS "startHere" JSONB;
ALTER TABLE "AuthorTranslation" ADD COLUMN IF NOT EXISTS "timeline" JSONB;
ALTER TABLE "AuthorTranslation" ADD COLUMN IF NOT EXISTS "influences" JSONB;
ALTER TABLE "AuthorTranslation" ADD COLUMN IF NOT EXISTS "awards" JSONB;
ALTER TABLE "AuthorTranslation" ADD COLUMN IF NOT EXISTS "adaptations" JSONB;
ALTER TABLE "AuthorTranslation" ADD COLUMN IF NOT EXISTS "funFacts" JSONB;
ALTER TABLE "AuthorTranslation" ADD COLUMN IF NOT EXISTS "sources" JSONB;

-- Дата смены перевода на языке (решение арбитра 15.10.2026, F02-2) — единственная колонка
-- с умолчанием и NOT NULL. Добавляется одним оператором сразу с умолчанием: прежний образ,
-- пишущий переводы во время выката, не знает колонки, и без умолчания его строка между
-- добавлением и NOT NULL уронила бы миграцию. Затем существующие строки получают дату
-- сохранения автора — точнее неё о прошлом ничего не известно.
ALTER TABLE "AuthorTranslation" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "AuthorTranslation" t SET "updatedAt" = a."updatedAt"
  FROM "Author" a WHERE a."id" = t."authorId";
