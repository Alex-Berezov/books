-- `LEGACY-015`, пачка `T21`: охват журнала административных действий расширен на последние
-- три пути физического удаления из одиннадцати - автор (`DELETE admin/authors/:id`),
-- персона (`DELETE admin/contributors/:id`) и страница (`DELETE admin/:lang/pages/:id`), -
-- и на смену публичной видимости страницы (`PATCH admin/:lang/pages/:id/publish|unpublish`).
-- Этой миграцией пункт 1 записи `LEGACY-015` закрывается целиком.
--
-- Видимость страницы журналируется **обеими** сторонами (решение арбитра 20.09.2026,
-- `decisions-log.md`). До этого решения снятие страницы с публикации стояло в скобке
-- soft-delete докблока `AdminAuditEvent` и тем съедало собственное «отдельное основание -
-- смена публичной видимости в обе стороны» того же предложения; канон решения и тело
-- `LEGACY-015` называют в исключении ровно два признака - `ARCHIVED` и `isDeleted`.
-- Односторонняя пара уже признавалась враньём журнала в `LEGACY-180`: снятие версии было
-- записано, публикация - нет, и по журналу версия оказывалась снята с публикации,
-- которой не было.
--
-- Типу объекта нужны три новых значения: события ложатся на автора, персону и страницу,
-- которых в `AdminAuditTargetType` не было. Персона названа по сущности, а не по маршруту:
-- отдельной модели `Contributor` в схеме нет вовсе, «контрибьютор» - это админское имя
-- строки `Person` (`contributors.service.ts` делегирует удаление в `persons.service.ts`).
--
-- `payload` есть только у удалений и только там, где он несёт то, что умирает вместе
-- со строкой: у автора - список `{ language, slug }` переводов, уходящих каскадом
-- `AuthorTranslation.author`, у страницы - её собственная пара `{ language, slug }`.
-- У персоны `payload` нет вовсе: всё, что у неё есть сверх идентификатора, - имя, а имён
-- и почт в журнале быть не должно (инвариант докблока `AdminAuditEvent`). У публикации
-- и снятия страницы `payload` нет по другой причине: строка жива, язык и слаг читаются
-- из неё самой.
--
-- Миграция только добавляющая: ни `DROP`, ни `RENAME`, ни сужения типа, ни правки
-- существующих значений. Значение перечисления в Postgres удалить нельзя вовсе, поэтому
-- откат образа ничего не теряет (ADR-018): прежний образ этих значений не пишет
-- и не читает, строк с ними до выката нового образа не появляется, а ручки чтения
-- журнала нет вовсе.
--
-- Идемпотентна намеренно, как и все пять предшественников
-- (`20260911150000_legacy_015_admin_audit_event`,
-- `20260912120000_legacy_180_audit_version_unpublished`,
-- `20260920120000_legacy_015_audit_publish_user_deleted`,
-- `20260920160000_legacy_015_audit_content_deletes`,
-- `20260920190000_legacy_015_audit_taxonomy_deletes`): оборванный накат оставил бы строку
-- с `finished_at = NULL` в `_prisma_migrations`, а она отвергает `P3009` **любую**
-- следующую пачку миграций до ручного разрешения на боевой машине, то есть до владельца.
-- `scripts/docker-entrypoint.sh` отказ `migrate deploy` глотает, поэтому наружу такой
-- выкат выглядит зелёным.
--
-- `ADD VALUE` в Postgres 12+ не переписывает таблиц: значение дописывается в каталог
-- типа, данные не трогаются, блокировка на таблицы не берётся. Добавленное значение
-- нельзя использовать в `INSERT`/`WHERE` этой же миграции - здесь оно и не используется.

-- AlterEnum
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'AUTHOR_DELETED';

-- AlterEnum
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'PERSON_DELETED';

-- AlterEnum
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'PAGE_DELETED';

-- AlterEnum
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'PAGE_PUBLISHED';

-- AlterEnum
ALTER TYPE "AdminAuditAction" ADD VALUE IF NOT EXISTS 'PAGE_UNPUBLISHED';

-- AlterEnum
ALTER TYPE "AdminAuditTargetType" ADD VALUE IF NOT EXISTS 'AUTHOR';

-- AlterEnum
ALTER TYPE "AdminAuditTargetType" ADD VALUE IF NOT EXISTS 'PERSON';

-- AlterEnum
ALTER TYPE "AdminAuditTargetType" ADD VALUE IF NOT EXISTS 'PAGE';
