-- LEGACY-443, пачка T117: "User"."email" хранится в нижнем регистре без пробелов по краям.
-- API теперь приводит адрес так на входе (регистрация, вход, админское создание и правка), а
-- "User"."email" - обычный @unique: до этой правки `Boss@x.com` и `boss@x.com` были двумя аккаунтами.
--
-- Нормальная форма - `lower()` без пробельных символов по краям (`\s`: пробел, таб, перевод строки) -
-- та же, что `normalizeEmail` в приложении (`String.trim()` + `toLowerCase()`).
--
-- Приводится только строка, чья нормальная форма ни с кем не сходится (решение арбитра B2,
-- 08.10.2026, `decisions-log.md`). Коллизии - аккаунты, которые после приведения стали бы одним
-- адресом, - не трогаются: слить их автоматически нельзя (у них разные книги и роли), а упавшая
-- миграция остановила бы выкат и оставила failed-запись в _prisma_migrations, снимаемую только
-- на сервере.
--
-- Коллизии пишутся в журнал "_legacy443_email_collisions" (решение арбитра V1): NOTICE из
-- `prisma migrate deploy` наружу не попадает, а таблицу видно на проде. Непустой журнал - пары
-- разбирает владелец (тема №2); до разбора аккаунт пары со смешанным регистром входом паролем
-- недоступен (вход ищет нижний регистр). Повтор безопасен: CREATE IF NOT EXISTS, ON CONFLICT
-- DO NOTHING, UPDATE трогает только ещё не приведённые строки без коллизий.
--
-- Окно выката (старый образ пишет адреса в смешанном регистре между миграцией и сменой образа)
-- закрывает вторая такая же миграция в ближайшем релизе books (`work-queue.md`, строка `T118`).
--
-- "UserIdentity"."email" - снимок адреса провайдера, ключа в нём нет, не трогается.
-- Уникального индекса по lower(email) нет и не заводится: Prisma его не описывает, и он упал бы
-- на тех же коллизиях. Снятие журнала - отдельная разрушительная миграция, решение владельца.
--
-- Откат данных невозможен (прежний регистр нигде не хранится) и не нужен: вход и регистрация
-- нормализуют адрес, прежний регистр ничего не открывал.

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
