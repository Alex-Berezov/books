-- Add unique constraint for ReadingProgress (userId, bookVersionId)
CREATE UNIQUE INDEX IF NOT EXISTS "ReadingProgress_userId_bookVersionId_key"
  ON "ReadingProgress" ("userId", "bookVersionId");
