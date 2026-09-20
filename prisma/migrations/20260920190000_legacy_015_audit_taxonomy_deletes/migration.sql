-- `LEGACY-015`, пачка `T20`: охват журнала административных действий расширен на четыре
-- пути физического удаления таксономии - категория (`DELETE categories/:id`) и её перевод
-- (`DELETE categories/:id/translations/:language`), тег (`DELETE tags/:id`) и его перевод
-- (`DELETE tags/:id/translations/:language`). До этой правки стирание термина, вместе
-- с которым умирают его публичные адреса на всех языках, не оставляло в журнале следа.
--
-- Типу объекта нужны два новых значения: события ложатся на категорию и тег, которых
-- в `AdminAuditTargetType` не было. Отдельного типа под перевод не заводится (решение
-- арбитра 20.09.2026): у события перевода `targetType` - `CATEGORY`/`TAG`, `targetId` -
-- идентификатор термина, язык стоит в `payload`. Так вся история термина, включая его
-- переводы, собирается одной выборкой по `targetId`.
--
-- Переводы, снесённые вместе с термином, отдельными событиями не журналируются: в
-- `AdminAuditAction` нет ни одного утверждения о переводе, которое их снос сделал бы
-- ложным, - в отличие от версий книги в `T19`, про которые уже записаны
-- `VERSION_PUBLISHED` и `VERSION_UNPUBLISHED`. Умершие адреса при этом не теряются:
-- `payload` события термина несёт список `{ language, slug }` из того же `dying`,
-- который оба сервиса и так читают ради уборки редиректов.
--
-- Миграция только добавляющая: ни `DROP`, ни `RENAME`, ни сужения типа, ни правки
-- существующих значений. Значение перечисления в Postgres удалить нельзя вовсе, поэтому
-- откат образа ничего не теряет (ADR-018): прежний образ этих значений не пишет
-- и не читает, строк с ними до выката нового образа не появляется, а ручки чтения
-- журнала нет вовсе.
--
-- Идемпотентна намеренно, как и все четыре предшественника
-- (`20260911150000_legacy_015_admin_audit_event`,
-- `20260912120000_legacy_180_audit_version_unpublished`,
-- `20260920120000_legacy_015_audit_publish_user_deleted`,
-- `20260920160000_legacy_015_audit_content_deletes`): оборванный накат оставил бы строку
-- с `finished_at = NULL` в `_prisma_migrations`, а она отвергает `P3009` **любую**
-- следующую пачку миграций до ручного разрешения на боевой машине, то есть до владельца.
-- `scripts/docker-entrypoint.sh` отказ `migrate deploy` глотает, поэтому наружу такой
-- выкат выглядит зелёным.
--
-- `ADD VALUE` в Postgres 12+ не переписывает таблиц: значение дописывается в каталог
-- типа, данные не трогаются, блокировка на таблицы не берётся. Добавленное значение
-- нельзя использовать в `INSERT`/`WHERE` этой же миграции - здесь оно и не используется.

-- AlterEnum
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'CATEGORY_DELETED';

-- AlterEnum
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'CATEGORY_TRANSLATION_DELETED';

-- AlterEnum
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'TAG_DELETED';

-- AlterEnum
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'TAG_TRANSLATION_DELETED';

-- AlterEnum
ALTER TYPE "AdminAuditTargetType" ADD VALUE IF NOT EXISTS 'CATEGORY';

-- AlterEnum
ALTER TYPE "AdminAuditTargetType" ADD VALUE IF NOT EXISTS 'TAG';
