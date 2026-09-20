-- `LEGACY-015`, пачка `T19`: охват журнала административных действий расширен на четыре
-- пути физического удаления книжного контура - книга (`DELETE books/:id`), версия
-- (`DELETE versions/:id`), глава (`DELETE chapters/:id`) и аудиоглава
-- (`DELETE audio-chapters/:id`). До этой правки журнал не молчал, а врал: по версии
-- уже записаны `VERSION_PUBLISHED` и `VERSION_UNPUBLISHED`, а самого удаления не было
-- нигде, и последнее, что журнал знал о стёртой версии, - что она опубликована.
--
-- Типу объекта новые значения нужны, в отличие от предыдущей пачки: события ложатся
-- на книгу, главу и аудиоглаву, которых в `AdminAuditTargetType` не было вовсе.
-- `BOOK_VERSION` и `USER` не трогаются.
--
-- Каскад журналируется на один уровень (решение арбитра 20.09.2026): удаление книги
-- пишет `VERSION_DELETED` на каждую снесённую каскадом версию, потому что каскад делает
-- ложными уже выкаченные утверждения о версии. Главы и аудиоглавы каскадом
-- не журналируются - по ним в перечислении нет ни одного утверждения, которое каскад
-- сделал бы ложным, а замок клиренса `LEGACY-368` внутри удаления книги не берётся.
--
-- Миграция только добавляющая: ни `DROP`, ни `RENAME`, ни сужения типа, ни правки
-- существующих значений. Значение перечисления в Postgres удалить нельзя вовсе, поэтому
-- откат образа ничего не теряет (ADR-018): прежний образ этих значений не пишет
-- и не читает, строк с ними до выката нового образа не появляется, а ручки чтения
-- журнала нет вовсе.
--
-- Идемпотентна намеренно, как и все три предшественника
-- (`20260911150000_legacy_015_admin_audit_event`,
-- `20260912120000_legacy_180_audit_version_unpublished`,
-- `20260920120000_legacy_015_audit_publish_user_deleted`): оборванный накат оставил бы
-- строку с `finished_at = NULL` в `_prisma_migrations`, а она отвергает `P3009` **любую**
-- следующую пачку миграций до ручного `migrate resolve` на боевой машине, то есть
-- до владельца. `scripts/docker-entrypoint.sh` отказ `migrate deploy` глотает, поэтому
-- наружу такой выкат выглядит зелёным.
--
-- `ADD VALUE` в Postgres 12+ не переписывает таблиц: значение дописывается в каталог
-- типа, данные не трогаются, блокировка на таблицы не берётся. Добавленное значение
-- нельзя использовать в `INSERT`/`WHERE` этой же миграции - здесь оно и не используется.

-- AlterEnum
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'BOOK_DELETED';

-- AlterEnum
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'VERSION_DELETED';

-- AlterEnum
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'CHAPTER_DELETED';

-- AlterEnum
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'AUDIO_CHAPTER_DELETED';

-- AlterEnum
ALTER TYPE "AdminAuditTargetType" ADD VALUE IF NOT EXISTS 'BOOK';

-- AlterEnum
ALTER TYPE "AdminAuditTargetType" ADD VALUE IF NOT EXISTS 'CHAPTER';

-- AlterEnum
ALTER TYPE "AdminAuditTargetType" ADD VALUE IF NOT EXISTS 'AUDIO_CHAPTER';
