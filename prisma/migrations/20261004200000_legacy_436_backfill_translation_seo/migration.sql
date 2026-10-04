-- LEGACY-436, пачка T100 (решение арбитра 04.10.2026, `decisions-log.md`): meta/OG перевода тега и категории,
-- записанные импортом, API без вложенного `seo` или старой модалкой до T96, лежат только в плоских колонках
-- перевода, а публика читает только "Seo" (`seo.service.ts`, `buildSocialCards.ts`). С этой правки писатели
-- переносят их сами (`src/shared/seo/translation-meta-seo.util.ts`); миграция переносит уже записанное.
--
-- Шесть полей: "metaTitle", "metaDescription", "ogTitle", "ogDescription", "ogImageUrl", "ogImageAlt".
-- Только добавляющая: пишется лишь пустое "Seo".X (NULL или из одних пробелов) непустым плоским X; заполненное
-- "Seo".X не перезаписывается. Перевод без "Seo" получает новую строку "Seo" с перенесёнными полями.
-- Строка "Seo", у которой кроме перевода есть другой владелец, не трогается: правка ушла бы и ему.
--
-- Журнал "_legacy436_backfill": строка на перевод — тип, перевод, "seoId", создана ли строка "Seo" миграцией
-- и прежние значения шести полей ("old", для созданных — NULL). Повтор безопасен: журнал пишется
-- ON CONFLICT DO NOTHING, перенос в существующую строку идёт, только пока её шесть полей равны "old",
-- новая строка "Seo" вставляется и привязывается, только пока у перевода нет "seoId".
--
-- Откат после выката — новой миграцией через конвейер, по журналу (возвращает прежние значения шести полей
-- целиком, в том числе поверх правок, сделанных после выката):
-- UPDATE "Seo" s SET "metaTitle" = b."old"->>'metaTitle', "metaDescription" = b."old"->>'metaDescription', "ogTitle" = b."old"->>'ogTitle', "ogDescription" = b."old"->>'ogDescription', "ogImageUrl" = b."old"->>'ogImageUrl', "ogImageAlt" = b."old"->>'ogImageAlt' FROM "_legacy436_backfill" b WHERE NOT b."created" AND s."id" = b."seoId";
-- UPDATE "CategoryTranslation" t SET "seoId" = NULL FROM "_legacy436_backfill" b WHERE b."created" AND b."kind" = 'category' AND t."id" = b."translationId" AND t."seoId" = b."seoId";
-- UPDATE "TagTranslation" t SET "seoId" = NULL FROM "_legacy436_backfill" b WHERE b."created" AND b."kind" = 'tag' AND t."id" = b."translationId" AND t."seoId" = b."seoId";
-- DELETE FROM "Seo" s USING "_legacy436_backfill" b WHERE b."created" AND s."id" = b."seoId" AND NOT EXISTS (SELECT 1 FROM "BookVersion" o WHERE o."seoId" = s."id") AND NOT EXISTS (SELECT 1 FROM "Page" o WHERE o."seoId" = s."id") AND NOT EXISTS (SELECT 1 FROM "AuthorTranslation" o WHERE o."seoId" = s."id") AND NOT EXISTS (SELECT 1 FROM "PersonTranslation" o WHERE o."seoId" = s."id") AND NOT EXISTS (SELECT 1 FROM "CategoryTranslation" o WHERE o."seoId" = s."id") AND NOT EXISTS (SELECT 1 FROM "TagTranslation" o WHERE o."seoId" = s."id");
-- Снятие журнала (DROP TABLE) — решение владельца, в пачку T106 не входит.

CREATE TABLE IF NOT EXISTS "_legacy436_backfill" (
    "kind" TEXT NOT NULL,
    "translationId" TEXT NOT NULL,
    "seoId" INTEGER NOT NULL,
    "created" BOOLEAN NOT NULL,
    "old" JSONB,

    CONSTRAINT "_legacy436_backfill_pkey" PRIMARY KEY ("kind", "translationId")
);

SELECT setval(
    pg_get_serial_sequence('"Seo"', 'id'),
    GREATEST(COALESCE((SELECT MAX("id") FROM "Seo"), 0), nextval(pg_get_serial_sequence('"Seo"', 'id')))
);

-- CategoryTranslation: существующая строка "Seo", где есть что перенести.
INSERT INTO "_legacy436_backfill" ("kind", "translationId", "seoId", "created", "old")
SELECT 'category', t."id", s."id", false, jsonb_build_object('metaTitle', s."metaTitle", 'metaDescription', s."metaDescription", 'ogTitle', s."ogTitle", 'ogDescription', s."ogDescription", 'ogImageUrl', s."ogImageUrl", 'ogImageAlt', s."ogImageAlt")
FROM "CategoryTranslation" t
JOIN "Seo" s ON s."id" = t."seoId"
WHERE ((NULLIF(btrim(t."metaTitle"), '') IS NOT NULL AND NULLIF(btrim(s."metaTitle"), '') IS NULL)
    OR (NULLIF(btrim(t."metaDescription"), '') IS NOT NULL AND NULLIF(btrim(s."metaDescription"), '') IS NULL)
    OR (NULLIF(btrim(t."ogTitle"), '') IS NOT NULL AND NULLIF(btrim(s."ogTitle"), '') IS NULL)
    OR (NULLIF(btrim(t."ogDescription"), '') IS NOT NULL AND NULLIF(btrim(s."ogDescription"), '') IS NULL)
    OR (NULLIF(btrim(t."ogImageUrl"), '') IS NOT NULL AND NULLIF(btrim(s."ogImageUrl"), '') IS NULL)
    OR (NULLIF(btrim(t."ogImageAlt"), '') IS NOT NULL AND NULLIF(btrim(s."ogImageAlt"), '') IS NULL))
  AND NOT EXISTS (SELECT 1 FROM "BookVersion" o WHERE o."seoId" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "Page" o WHERE o."seoId" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "AuthorTranslation" o WHERE o."seoId" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "PersonTranslation" o WHERE o."seoId" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "CategoryTranslation" o WHERE o."seoId" = s."id" AND o."id" <> t."id")
  AND NOT EXISTS (SELECT 1 FROM "TagTranslation" o WHERE o."seoId" = s."id")
ON CONFLICT ("kind", "translationId") DO NOTHING;

-- CategoryTranslation: перевод без "Seo" с непустыми meta/OG — номер будущей строки.
INSERT INTO "_legacy436_backfill" ("kind", "translationId", "seoId", "created", "old")
SELECT 'category', t."id", nextval(pg_get_serial_sequence('"Seo"', 'id')), true, NULL
FROM "CategoryTranslation" t
WHERE t."seoId" IS NULL
  AND (NULLIF(btrim(t."metaTitle"), '') IS NOT NULL OR NULLIF(btrim(t."metaDescription"), '') IS NOT NULL OR NULLIF(btrim(t."ogTitle"), '') IS NOT NULL OR NULLIF(btrim(t."ogDescription"), '') IS NOT NULL OR NULLIF(btrim(t."ogImageUrl"), '') IS NOT NULL OR NULLIF(btrim(t."ogImageAlt"), '') IS NOT NULL)
ON CONFLICT ("kind", "translationId") DO NOTHING;

UPDATE "Seo" s
SET "metaTitle" = CASE WHEN NULLIF(btrim(s."metaTitle"), '') IS NULL AND NULLIF(btrim(t."metaTitle"), '') IS NOT NULL THEN t."metaTitle" ELSE s."metaTitle" END,
    "metaDescription" = CASE WHEN NULLIF(btrim(s."metaDescription"), '') IS NULL AND NULLIF(btrim(t."metaDescription"), '') IS NOT NULL THEN t."metaDescription" ELSE s."metaDescription" END,
    "ogTitle" = CASE WHEN NULLIF(btrim(s."ogTitle"), '') IS NULL AND NULLIF(btrim(t."ogTitle"), '') IS NOT NULL THEN t."ogTitle" ELSE s."ogTitle" END,
    "ogDescription" = CASE WHEN NULLIF(btrim(s."ogDescription"), '') IS NULL AND NULLIF(btrim(t."ogDescription"), '') IS NOT NULL THEN t."ogDescription" ELSE s."ogDescription" END,
    "ogImageUrl" = CASE WHEN NULLIF(btrim(s."ogImageUrl"), '') IS NULL AND NULLIF(btrim(t."ogImageUrl"), '') IS NOT NULL THEN t."ogImageUrl" ELSE s."ogImageUrl" END,
    "ogImageAlt" = CASE WHEN NULLIF(btrim(s."ogImageAlt"), '') IS NULL AND NULLIF(btrim(t."ogImageAlt"), '') IS NOT NULL THEN t."ogImageAlt" ELSE s."ogImageAlt" END,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "_legacy436_backfill" b
JOIN "CategoryTranslation" t ON t."id" = b."translationId" AND t."seoId" = b."seoId"
WHERE b."kind" = 'category'
  AND NOT b."created"
  AND s."id" = b."seoId"
  AND (s."metaTitle", s."metaDescription", s."ogTitle", s."ogDescription", s."ogImageUrl", s."ogImageAlt") IS NOT DISTINCT FROM (b."old"->>'metaTitle', b."old"->>'metaDescription', b."old"->>'ogTitle', b."old"->>'ogDescription', b."old"->>'ogImageUrl', b."old"->>'ogImageAlt');

INSERT INTO "Seo" ("id", "createdAt", "updatedAt", "metaTitle", "metaDescription", "ogTitle", "ogDescription", "ogImageUrl", "ogImageAlt")
SELECT b."seoId", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
    CASE WHEN NULLIF(btrim(t."metaTitle"), '') IS NOT NULL THEN t."metaTitle" END,
    CASE WHEN NULLIF(btrim(t."metaDescription"), '') IS NOT NULL THEN t."metaDescription" END,
    CASE WHEN NULLIF(btrim(t."ogTitle"), '') IS NOT NULL THEN t."ogTitle" END,
    CASE WHEN NULLIF(btrim(t."ogDescription"), '') IS NOT NULL THEN t."ogDescription" END,
    CASE WHEN NULLIF(btrim(t."ogImageUrl"), '') IS NOT NULL THEN t."ogImageUrl" END,
    CASE WHEN NULLIF(btrim(t."ogImageAlt"), '') IS NOT NULL THEN t."ogImageAlt" END
FROM "_legacy436_backfill" b
JOIN "CategoryTranslation" t ON t."id" = b."translationId"
WHERE b."kind" = 'category'
  AND b."created"
  AND t."seoId" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "Seo" n WHERE n."id" = b."seoId");

UPDATE "CategoryTranslation" t
SET "seoId" = b."seoId"
FROM "_legacy436_backfill" b
WHERE b."kind" = 'category'
  AND b."created"
  AND t."id" = b."translationId"
  AND t."seoId" IS NULL
  AND EXISTS (SELECT 1 FROM "Seo" n WHERE n."id" = b."seoId")
  AND NOT EXISTS (SELECT 1 FROM "BookVersion" o WHERE o."seoId" = b."seoId")
  AND NOT EXISTS (SELECT 1 FROM "Page" o WHERE o."seoId" = b."seoId")
  AND NOT EXISTS (SELECT 1 FROM "AuthorTranslation" o WHERE o."seoId" = b."seoId")
  AND NOT EXISTS (SELECT 1 FROM "PersonTranslation" o WHERE o."seoId" = b."seoId")
  AND NOT EXISTS (SELECT 1 FROM "CategoryTranslation" o WHERE o."seoId" = b."seoId")
  AND NOT EXISTS (SELECT 1 FROM "TagTranslation" o WHERE o."seoId" = b."seoId");

-- TagTranslation: существующая строка "Seo", где есть что перенести.
INSERT INTO "_legacy436_backfill" ("kind", "translationId", "seoId", "created", "old")
SELECT 'tag', t."id", s."id", false, jsonb_build_object('metaTitle', s."metaTitle", 'metaDescription', s."metaDescription", 'ogTitle', s."ogTitle", 'ogDescription', s."ogDescription", 'ogImageUrl', s."ogImageUrl", 'ogImageAlt', s."ogImageAlt")
FROM "TagTranslation" t
JOIN "Seo" s ON s."id" = t."seoId"
WHERE ((NULLIF(btrim(t."metaTitle"), '') IS NOT NULL AND NULLIF(btrim(s."metaTitle"), '') IS NULL)
    OR (NULLIF(btrim(t."metaDescription"), '') IS NOT NULL AND NULLIF(btrim(s."metaDescription"), '') IS NULL)
    OR (NULLIF(btrim(t."ogTitle"), '') IS NOT NULL AND NULLIF(btrim(s."ogTitle"), '') IS NULL)
    OR (NULLIF(btrim(t."ogDescription"), '') IS NOT NULL AND NULLIF(btrim(s."ogDescription"), '') IS NULL)
    OR (NULLIF(btrim(t."ogImageUrl"), '') IS NOT NULL AND NULLIF(btrim(s."ogImageUrl"), '') IS NULL)
    OR (NULLIF(btrim(t."ogImageAlt"), '') IS NOT NULL AND NULLIF(btrim(s."ogImageAlt"), '') IS NULL))
  AND NOT EXISTS (SELECT 1 FROM "BookVersion" o WHERE o."seoId" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "Page" o WHERE o."seoId" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "AuthorTranslation" o WHERE o."seoId" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "PersonTranslation" o WHERE o."seoId" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "CategoryTranslation" o WHERE o."seoId" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "TagTranslation" o WHERE o."seoId" = s."id" AND o."id" <> t."id")
ON CONFLICT ("kind", "translationId") DO NOTHING;

-- TagTranslation: перевод без "Seo" с непустыми meta/OG — номер будущей строки.
INSERT INTO "_legacy436_backfill" ("kind", "translationId", "seoId", "created", "old")
SELECT 'tag', t."id", nextval(pg_get_serial_sequence('"Seo"', 'id')), true, NULL
FROM "TagTranslation" t
WHERE t."seoId" IS NULL
  AND (NULLIF(btrim(t."metaTitle"), '') IS NOT NULL OR NULLIF(btrim(t."metaDescription"), '') IS NOT NULL OR NULLIF(btrim(t."ogTitle"), '') IS NOT NULL OR NULLIF(btrim(t."ogDescription"), '') IS NOT NULL OR NULLIF(btrim(t."ogImageUrl"), '') IS NOT NULL OR NULLIF(btrim(t."ogImageAlt"), '') IS NOT NULL)
ON CONFLICT ("kind", "translationId") DO NOTHING;

UPDATE "Seo" s
SET "metaTitle" = CASE WHEN NULLIF(btrim(s."metaTitle"), '') IS NULL AND NULLIF(btrim(t."metaTitle"), '') IS NOT NULL THEN t."metaTitle" ELSE s."metaTitle" END,
    "metaDescription" = CASE WHEN NULLIF(btrim(s."metaDescription"), '') IS NULL AND NULLIF(btrim(t."metaDescription"), '') IS NOT NULL THEN t."metaDescription" ELSE s."metaDescription" END,
    "ogTitle" = CASE WHEN NULLIF(btrim(s."ogTitle"), '') IS NULL AND NULLIF(btrim(t."ogTitle"), '') IS NOT NULL THEN t."ogTitle" ELSE s."ogTitle" END,
    "ogDescription" = CASE WHEN NULLIF(btrim(s."ogDescription"), '') IS NULL AND NULLIF(btrim(t."ogDescription"), '') IS NOT NULL THEN t."ogDescription" ELSE s."ogDescription" END,
    "ogImageUrl" = CASE WHEN NULLIF(btrim(s."ogImageUrl"), '') IS NULL AND NULLIF(btrim(t."ogImageUrl"), '') IS NOT NULL THEN t."ogImageUrl" ELSE s."ogImageUrl" END,
    "ogImageAlt" = CASE WHEN NULLIF(btrim(s."ogImageAlt"), '') IS NULL AND NULLIF(btrim(t."ogImageAlt"), '') IS NOT NULL THEN t."ogImageAlt" ELSE s."ogImageAlt" END,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "_legacy436_backfill" b
JOIN "TagTranslation" t ON t."id" = b."translationId" AND t."seoId" = b."seoId"
WHERE b."kind" = 'tag'
  AND NOT b."created"
  AND s."id" = b."seoId"
  AND (s."metaTitle", s."metaDescription", s."ogTitle", s."ogDescription", s."ogImageUrl", s."ogImageAlt") IS NOT DISTINCT FROM (b."old"->>'metaTitle', b."old"->>'metaDescription', b."old"->>'ogTitle', b."old"->>'ogDescription', b."old"->>'ogImageUrl', b."old"->>'ogImageAlt');

INSERT INTO "Seo" ("id", "createdAt", "updatedAt", "metaTitle", "metaDescription", "ogTitle", "ogDescription", "ogImageUrl", "ogImageAlt")
SELECT b."seoId", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
    CASE WHEN NULLIF(btrim(t."metaTitle"), '') IS NOT NULL THEN t."metaTitle" END,
    CASE WHEN NULLIF(btrim(t."metaDescription"), '') IS NOT NULL THEN t."metaDescription" END,
    CASE WHEN NULLIF(btrim(t."ogTitle"), '') IS NOT NULL THEN t."ogTitle" END,
    CASE WHEN NULLIF(btrim(t."ogDescription"), '') IS NOT NULL THEN t."ogDescription" END,
    CASE WHEN NULLIF(btrim(t."ogImageUrl"), '') IS NOT NULL THEN t."ogImageUrl" END,
    CASE WHEN NULLIF(btrim(t."ogImageAlt"), '') IS NOT NULL THEN t."ogImageAlt" END
FROM "_legacy436_backfill" b
JOIN "TagTranslation" t ON t."id" = b."translationId"
WHERE b."kind" = 'tag'
  AND b."created"
  AND t."seoId" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "Seo" n WHERE n."id" = b."seoId");

UPDATE "TagTranslation" t
SET "seoId" = b."seoId"
FROM "_legacy436_backfill" b
WHERE b."kind" = 'tag'
  AND b."created"
  AND t."id" = b."translationId"
  AND t."seoId" IS NULL
  AND EXISTS (SELECT 1 FROM "Seo" n WHERE n."id" = b."seoId")
  AND NOT EXISTS (SELECT 1 FROM "BookVersion" o WHERE o."seoId" = b."seoId")
  AND NOT EXISTS (SELECT 1 FROM "Page" o WHERE o."seoId" = b."seoId")
  AND NOT EXISTS (SELECT 1 FROM "AuthorTranslation" o WHERE o."seoId" = b."seoId")
  AND NOT EXISTS (SELECT 1 FROM "PersonTranslation" o WHERE o."seoId" = b."seoId")
  AND NOT EXISTS (SELECT 1 FROM "CategoryTranslation" o WHERE o."seoId" = b."seoId")
  AND NOT EXISTS (SELECT 1 FROM "TagTranslation" o WHERE o."seoId" = b."seoId");
