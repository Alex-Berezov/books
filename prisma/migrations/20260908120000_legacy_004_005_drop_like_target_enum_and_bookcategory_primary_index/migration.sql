-- LEGACY-004: enum `LikeTarget` is not referenced by any column (Like uses
-- commentId/bookVersionId FKs as an XOR discriminator, not a targetType enum).
-- Safe to drop: no data loss, nothing reads or writes it.
DROP TYPE IF EXISTS "LikeTarget";

-- LEGACY-005: prevent more than one primary category per book version at the
-- database level. `isPrimary` is currently never written as true anywhere in
-- `src` (BookVersion.primaryCategoryId is the only field actually read for
-- breadcrumb/SEO), so this constraint cannot reject any existing row; it only
-- closes the future failure mode described in the legacy record.
CREATE UNIQUE INDEX IF NOT EXISTS "BookCategory_bookVersionId_isPrimary_key" ON "BookCategory"("bookVersionId") WHERE "isPrimary" = true;
