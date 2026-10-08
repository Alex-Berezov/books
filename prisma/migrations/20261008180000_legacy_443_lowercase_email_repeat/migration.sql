-- LEGACY-443, пачка T118: повтор приведения "User"."email" к нормальной форме (решение арбитра V1,
-- 08.10.2026, `decisions-log.md`).
--
-- Первая миграция (`20261008120000_legacy_443_lowercase_email`, тег T117) прошла раньше смены образа:
-- между `run_migrations` и `deploy_services` старый образ ещё принимал регистрацию и правку адреса
-- без нормализации и мог записать адрес в смешанном регистре. Образ T117 нормализует адрес сам,
-- поэтому после этой миграции окно закрыто.
--
-- Тело совпадает с первой миграцией: коллизии - в журнал "_legacy443_email_collisions" (таблица уже
-- есть, CREATE IF NOT EXISTS - для базы, где первая миграция почему-то не прошла), приводятся только
-- строки без коллизий. Повтор безопасен; на базе без новых адресов миграция ничего не меняет.
-- Разбор непустого журнала - владелец (тело `LEGACY-443`).

CREATE TABLE IF NOT EXISTS "_legacy443_email_collisions" (
    "userId" TEXT NOT NULL,
    "normalizedEmail" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "_legacy443_email_collisions_pkey" PRIMARY KEY ("userId")
);

INSERT INTO "_legacy443_email_collisions" ("userId", "normalizedEmail", "email")
SELECT u."id", lower(regexp_replace(u."email", '^\s+|\s+$', '', 'g')), u."email"
  FROM "User" u
 WHERE EXISTS (
   SELECT 1
     FROM "User" o
    WHERE o."id" <> u."id"
      AND lower(regexp_replace(o."email", '^\s+|\s+$', '', 'g')) = lower(regexp_replace(u."email", '^\s+|\s+$', '', 'g'))
 )
ON CONFLICT ("userId") DO NOTHING;

UPDATE "User" u
   SET "email" = lower(regexp_replace(u."email", '^\s+|\s+$', '', 'g'))
 WHERE u."email" <> lower(regexp_replace(u."email", '^\s+|\s+$', '', 'g'))
   AND NOT EXISTS (
     SELECT 1
       FROM "User" o
      WHERE o."id" <> u."id"
        AND lower(regexp_replace(o."email", '^\s+|\s+$', '', 'g')) = lower(regexp_replace(u."email", '^\s+|\s+$', '', 'g'))
   );
