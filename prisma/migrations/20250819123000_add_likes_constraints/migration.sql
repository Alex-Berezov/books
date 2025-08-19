-- Add unique constraints and indexes for Like model
CREATE UNIQUE INDEX IF NOT EXISTS "Like_userId_commentId_key" ON "Like" ("userId", "commentId") WHERE "commentId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "Like_userId_bookVersionId_key" ON "Like" ("userId", "bookVersionId") WHERE "bookVersionId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "Like_commentId_idx" ON "Like" ("commentId");
CREATE INDEX IF NOT EXISTS "Like_bookVersionId_idx" ON "Like" ("bookVersionId");
-- Optional XOR check (deferred): requires Postgres CHECK with OR / IS DISTINCT FROM
-- ALTER TABLE "Like" ADD CONSTRAINT like_xor_target CHECK (
--   ("commentId" IS NOT NULL AND "bookVersionId" IS NULL) OR
--   ("commentId" IS NULL AND "bookVersionId" IS NOT NULL)
-- );
