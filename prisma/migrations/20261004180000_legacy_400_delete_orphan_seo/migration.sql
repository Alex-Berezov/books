-- LEGACY-400, слово владельца 04.10.2026: «разрешаю удалить ничьи Seo миграцией с резервной таблицей».
-- Строка "Seo", на которую не ссылается ни один из шести владельцев ("BookVersion", "Page",
-- "AuthorTranslation", "PersonTranslation", "CategoryTranslation", "TagTranslation" — тот же список,
-- что `SEO_OWNER_RELATIONS` в `src/shared/seo/seo-orphan.util.ts`), мету никому не отдаёт, но её адреса
-- картинок держат медиа от уборки (LEGACY-413). Боевой замер 03.10.2026: 982 такие строки из 3310.
--
-- Удаление откатываемое по строкам, но не по файлам: каждая удаляемая строка сначала копируется целиком
-- в "_legacy400_orphan_seo"."row" (`to_jsonb`), и в резервной таблице оказываются ровно удалённые строки
-- в том виде, в каком их удалили.
-- Откат после выката — только вперёд, новой миграцией через конвейер:
-- INSERT INTO "Seo" SELECT r.* FROM "_legacy400_orphan_seo" b CROSS JOIN LATERAL jsonb_populate_record(NULL::"Seo", b."row") r
-- WHERE NOT EXISTS (SELECT 1 FROM "Seo" s WHERE s."id" = b."id");
-- Рецепт написан под форму "Seo" на 04.10.2026: если у таблицы появится колонка NOT NULL (даже с умолчанием),
-- `jsonb_populate_record` даст в ней NULL — тогда откат перечисляет колонки явно и подставляет умолчание.
-- Резервная таблица из поиска медиа исключена (`media-references.spec.ts`): адрес, оставшийся только в ней,
-- уборка сочтёт ничьим — ради этого строки и удаляются. Файл такой картинки уборка удалит после срока
-- `hardDays`, и откат вернёт строку с адресом на несуществующий файл; мету восстановленная строка
-- всё равно никому не отдаёт.
-- DROP резервной таблицы — отложенная пачка `T106` (слово владельца 04.10.2026, срок — решение арбитра,
-- `decisions-log.md`), миграцией здесь не делается.
--
-- Порядок внутри блока DO — замок, копия, удаление, — и каждый оператор PL/pgSQL в READ COMMITTED читает
-- свежий снимок. Замок FOR UPDATE берётся на строки, ничьи на момент замка; он ждёт открытые привязки
-- старого образа (legacy `seoId` страницы, `pages.service.ts` `assertSeoAttachable`: внешний ключ держит
-- на "Seo" FOR KEY SHARE) и правки строк. Пока замок держится, запертую строку никто не изменит и не привяжет:
-- новая привязка встаёт в очередь и после удаления получает отказ внешнего ключа — 400. Копия и удаление
-- идут по запертым строкам с той же сверкой владельцев, поэтому копируется ровно то, что удаляется:
-- привязанная за время ожидания строка не попадёт ни в копию, ни в удаление, строка, которую до замка
-- удалило само приложение, — тоже. Без замка DELETE дождался бы чужого коммита и удалил строку по снимку
-- начала оператора, а ON DELETE SET NULL молча обнулил бы `seoId` только что сохранённой страницы.
--
-- Повтор безопасен: копия обновляется до текущего содержимого (ON CONFLICT DO UPDATE), копии прошлых
-- прогонов не трогаются, удаление заново сверяет владельцев. На базе без ничьих строк все операции пустые.

CREATE TABLE IF NOT EXISTS "_legacy400_orphan_seo" (
    "id" INTEGER NOT NULL,
    "row" JSONB NOT NULL,

    CONSTRAINT "_legacy400_orphan_seo_pkey" PRIMARY KEY ("id")
);

DO $$
DECLARE
  locked_ids INTEGER[];
BEGIN
  SELECT array_agg(locked."id") INTO locked_ids FROM (
    SELECT s."id" FROM "Seo" s
    WHERE NOT EXISTS (SELECT 1 FROM "BookVersion" o WHERE o."seoId" = s."id")
      AND NOT EXISTS (SELECT 1 FROM "Page" o WHERE o."seoId" = s."id")
      AND NOT EXISTS (SELECT 1 FROM "AuthorTranslation" o WHERE o."seoId" = s."id")
      AND NOT EXISTS (SELECT 1 FROM "PersonTranslation" o WHERE o."seoId" = s."id")
      AND NOT EXISTS (SELECT 1 FROM "CategoryTranslation" o WHERE o."seoId" = s."id")
      AND NOT EXISTS (SELECT 1 FROM "TagTranslation" o WHERE o."seoId" = s."id")
    ORDER BY s."id"
    FOR UPDATE OF s
  ) locked;
  INSERT INTO "_legacy400_orphan_seo" ("id", "row")
  SELECT s."id", to_jsonb(s.*)
  FROM "Seo" s
  WHERE s."id" = ANY(locked_ids)
    AND NOT EXISTS (SELECT 1 FROM "BookVersion" o WHERE o."seoId" = s."id")
    AND NOT EXISTS (SELECT 1 FROM "Page" o WHERE o."seoId" = s."id")
    AND NOT EXISTS (SELECT 1 FROM "AuthorTranslation" o WHERE o."seoId" = s."id")
    AND NOT EXISTS (SELECT 1 FROM "PersonTranslation" o WHERE o."seoId" = s."id")
    AND NOT EXISTS (SELECT 1 FROM "CategoryTranslation" o WHERE o."seoId" = s."id")
    AND NOT EXISTS (SELECT 1 FROM "TagTranslation" o WHERE o."seoId" = s."id")
  ON CONFLICT ("id") DO UPDATE SET "row" = EXCLUDED."row";
  DELETE FROM "Seo" s
  USING "_legacy400_orphan_seo" b
  WHERE s."id" = b."id"
    AND s."id" = ANY(locked_ids)
    AND b."row" = to_jsonb(s.*)
    AND NOT EXISTS (SELECT 1 FROM "BookVersion" o WHERE o."seoId" = s."id")
    AND NOT EXISTS (SELECT 1 FROM "Page" o WHERE o."seoId" = s."id")
    AND NOT EXISTS (SELECT 1 FROM "AuthorTranslation" o WHERE o."seoId" = s."id")
    AND NOT EXISTS (SELECT 1 FROM "PersonTranslation" o WHERE o."seoId" = s."id")
    AND NOT EXISTS (SELECT 1 FROM "CategoryTranslation" o WHERE o."seoId" = s."id")
    AND NOT EXISTS (SELECT 1 FROM "TagTranslation" o WHERE o."seoId" = s."id");
END $$;
