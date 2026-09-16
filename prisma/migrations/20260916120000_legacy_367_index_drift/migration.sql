-- LEGACY-367: schema.prisma and the indexes the migrations actually build had drifted apart.
-- Found by the index pass added to scripts/drift-check.mjs in the same change.

-- 1. BookCategory(categoryId). schema.prisma declared `@@index([categoryId])`, no migration
-- created it. The composite unique index BookCategory_bookVersionId_categoryId_key
-- (20250817123500) leads with `bookVersionId` and does not serve a lookup by `categoryId` alone:
-- `categories: { some: { categoryId } }` in BookService.getBookIdsByCategory
-- (src/modules/book/book.service.ts) and in the category listings has nothing to use.
-- No separate index on `bookVersionId`: the composite index's leading column already serves it
-- (arbiter decision 16.09.2026, the declaration was removed from schema.prisma instead).
--
-- 2. Like: the two unique indexes are partial in every database built from migrations.
-- 20250819123000 created them with `WHERE "<c>" IS NOT NULL`; 20250825112250 and
-- 20250825124124 meant to replace them with full ones, but `CREATE UNIQUE INDEX IF NOT EXISTS`
-- under the same name is a no-op, so the partial ones stayed. schema.prisma declares full
-- `@@unique([userId, commentId])` / `@@unique([userId, bookVersionId])`, and Prisma's native
-- upsert (`ON CONFLICT ("userId", "commentId")`) cannot infer a partial index.
-- Data-safe: the partial index already guarantees uniqueness of every row with a non-null
-- column, and rows with NULL never conflict under NULLS DISTINCT (the Postgres default).
-- For each index the order is create full -> drop partial -> rename, so the table always has a
-- unique index on the pair. Every statement is idempotent. Arbiter decision 16.09.2026
-- (books-app-docs/ai-context/decisions-log.md).
--
-- Locks. Prisma sends this file as one multi-statement script, which Postgres runs as a single
-- implicit transaction (that is also why CONCURRENTLY is impossible here): every lock below is
-- held until the end of the file, not for one step. CREATE INDEX takes SHARE — writes to the
-- table wait, reads go on. DROP INDEX takes ACCESS EXCLUSIVE — reads wait too, and it first
-- waits behind any reader of "Like" already running, with new reads queueing behind it.
-- So both builds run first and the ACCESS EXCLUSIVE steps come last: reads of "Like" stop only
-- for the drops and renames at the very end, writes to "Like" and "BookCategory" stop for the
-- whole file. No lock_timeout on purpose: a timed-out migration would be left failed on the VPS
-- (P3009), and only a manual `migrate resolve` there clears it (arbiter decision 16.09.2026).

CREATE INDEX IF NOT EXISTS "BookCategory_categoryId_idx" ON "BookCategory"("categoryId");

CREATE UNIQUE INDEX IF NOT EXISTS "Like_userId_commentId_key_full" ON "Like"("userId", "commentId");
CREATE UNIQUE INDEX IF NOT EXISTS "Like_userId_bookVersionId_key_full" ON "Like"("userId", "bookVersionId");

DROP INDEX IF EXISTS "Like_userId_commentId_key";
ALTER INDEX IF EXISTS "Like_userId_commentId_key_full" RENAME TO "Like_userId_commentId_key";

DROP INDEX IF EXISTS "Like_userId_bookVersionId_key";
ALTER INDEX IF EXISTS "Like_userId_bookVersionId_key_full" RENAME TO "Like_userId_bookVersionId_key";
