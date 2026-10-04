-- LEGACY-400, решение арбитра T99 (04.10.2026). Миграция фазы 14 скопировала `seoId` автора
-- в перевод персоны, и одна строка "Seo" принадлежит сразу "AuthorTranslation" и
-- "PersonTranslation" (боевой замер 03.10.2026: 45 пар). Правило «одна `Seo` — один владелец»
-- нарушено; автор и персона сегодня `Seo` на месте не правят, но первая такая правка у любого
-- из них изменит мету обоих. Персона получает свою копию, автор остаётся при своей строке.
--
-- Только INSERT и UPDATE, без DELETE: пара старого и нового id лежит в "_legacy400_person_seo".
-- Откат после выката — только вперёд, новой миграцией через конвейер:
-- UPDATE "PersonTranslation" pt SET "seoId" = b."oldSeoId" FROM "_legacy400_person_seo" b
-- WHERE pt."id" = b."personTranslationId" AND pt."seoId" = b."newSeoId"
--   AND EXISTS (SELECT 1 FROM "Seo" s WHERE s."id" = b."oldSeoId");
-- Копии "Seo" после такого отката станут ничьими: мету они никому не отдают, но держат медиа от уборки
-- (LEGACY-413) — их уборка идёт вместе с остальными сиротами. DROP резервной таблицы —
-- решение владельца (тема №2), миграцией не делается.
--
-- Повтор безопасен: пара — ON CONFLICT DO NOTHING, копия — только если её id ещё нет,
-- переключение — только пока перевод держит старую строку. На базе без общих строк всё пусто.
--
-- Новый id берётся из последовательности "Seo". Отстань она от MAX("id") (сид, импорт, восстановление
-- с явными id), nextval выдал бы id чужой строки, копия бы не вставилась, а перевод ушёл бы на чужую
-- мету. Поэтому последовательность сначала подтягивается к MAX("id"), а переключение идёт только на
-- строку без единого из шести владельцев, совпадающую со старой во всех полях вместе с "createdAt",
-- то есть на копию: строка другого владельца (даже двойник по полям) и ничья строка с чужой метой
-- (на проде таких 982) под это не подходят.

CREATE TABLE IF NOT EXISTS "_legacy400_person_seo" (
    "personTranslationId" TEXT NOT NULL,
    "oldSeoId" INTEGER NOT NULL,
    "newSeoId" INTEGER NOT NULL,

    CONSTRAINT "_legacy400_person_seo_pkey" PRIMARY KEY ("personTranslationId")
);

SELECT setval(
    pg_get_serial_sequence('"Seo"', 'id'),
    GREATEST(COALESCE((SELECT MAX("id") FROM "Seo"), 0), nextval(pg_get_serial_sequence('"Seo"', 'id')))
);

INSERT INTO "_legacy400_person_seo" ("personTranslationId", "oldSeoId", "newSeoId")
SELECT pt."id", pt."seoId", nextval(pg_get_serial_sequence('"Seo"', 'id'))
FROM "PersonTranslation" pt
WHERE pt."seoId" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "AuthorTranslation" at WHERE at."seoId" = pt."seoId")
ON CONFLICT ("personTranslationId") DO NOTHING;

INSERT INTO "Seo" (
    "id", "createdAt", "updatedAt",
    "metaTitle", "metaDescription", "canonicalUrl", "robots",
    "ogTitle", "ogDescription", "ogType", "ogUrl", "ogImageUrl", "ogImageAlt",
    "twitterCard", "twitterSite", "twitterCreator",
    "eventName", "eventDescription", "eventStartDate", "eventEndDate", "eventUrl", "eventImageUrl",
    "eventLocationName", "eventLocationStreet", "eventLocationCity", "eventLocationRegion",
    "eventLocationPostal", "eventLocationCountry"
)
SELECT
    b."newSeoId", s."createdAt", CURRENT_TIMESTAMP,
    s."metaTitle", s."metaDescription", s."canonicalUrl", s."robots",
    s."ogTitle", s."ogDescription", s."ogType", s."ogUrl", s."ogImageUrl", s."ogImageAlt",
    s."twitterCard", s."twitterSite", s."twitterCreator",
    s."eventName", s."eventDescription", s."eventStartDate", s."eventEndDate", s."eventUrl", s."eventImageUrl",
    s."eventLocationName", s."eventLocationStreet", s."eventLocationCity", s."eventLocationRegion",
    s."eventLocationPostal", s."eventLocationCountry"
FROM "_legacy400_person_seo" b
JOIN "Seo" s ON s."id" = b."oldSeoId"
JOIN "PersonTranslation" pt ON pt."id" = b."personTranslationId" AND pt."seoId" = b."oldSeoId"
WHERE NOT EXISTS (SELECT 1 FROM "Seo" n WHERE n."id" = b."newSeoId");

UPDATE "PersonTranslation" pt
SET "seoId" = b."newSeoId"
FROM "_legacy400_person_seo" b
JOIN "Seo" s ON s."id" = b."oldSeoId"
JOIN "Seo" n ON n."id" = b."newSeoId"
WHERE pt."id" = b."personTranslationId"
  AND pt."seoId" = b."oldSeoId"
  AND NOT EXISTS (SELECT 1 FROM "BookVersion" o WHERE o."seoId" = b."newSeoId")
  AND NOT EXISTS (SELECT 1 FROM "Page" o WHERE o."seoId" = b."newSeoId")
  AND NOT EXISTS (SELECT 1 FROM "AuthorTranslation" o WHERE o."seoId" = b."newSeoId")
  AND NOT EXISTS (SELECT 1 FROM "PersonTranslation" o WHERE o."seoId" = b."newSeoId")
  AND NOT EXISTS (SELECT 1 FROM "CategoryTranslation" o WHERE o."seoId" = b."newSeoId")
  AND NOT EXISTS (SELECT 1 FROM "TagTranslation" o WHERE o."seoId" = b."newSeoId")
  AND (
    n."createdAt", n."metaTitle", n."metaDescription", n."canonicalUrl", n."robots", n."ogTitle",
    n."ogDescription", n."ogType", n."ogUrl", n."ogImageUrl", n."ogImageAlt", n."twitterCard",
    n."twitterSite", n."twitterCreator", n."eventName", n."eventDescription", n."eventStartDate",
    n."eventEndDate", n."eventUrl", n."eventImageUrl", n."eventLocationName",
    n."eventLocationStreet", n."eventLocationCity", n."eventLocationRegion",
    n."eventLocationPostal", n."eventLocationCountry"
  ) IS NOT DISTINCT FROM (
    s."createdAt", s."metaTitle", s."metaDescription", s."canonicalUrl", s."robots", s."ogTitle",
    s."ogDescription", s."ogType", s."ogUrl", s."ogImageUrl", s."ogImageAlt", s."twitterCard",
    s."twitterSite", s."twitterCreator", s."eventName", s."eventDescription", s."eventStartDate",
    s."eventEndDate", s."eventUrl", s."eventImageUrl", s."eventLocationName",
    s."eventLocationStreet", s."eventLocationCity", s."eventLocationRegion",
    s."eventLocationPostal", s."eventLocationCountry"
  );
