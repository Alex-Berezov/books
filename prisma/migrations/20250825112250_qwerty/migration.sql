/*
  Warnings:

  - A unique constraint covering the columns `[userId,commentId]` on the table `Like` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[userId,bookVersionId]` on the table `Like` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex (idempotent to avoid duplicate name errors in shadow DB)
CREATE UNIQUE INDEX IF NOT EXISTS "Like_userId_commentId_key" ON "public"."Like"("userId", "commentId");

-- CreateIndex (idempotent to avoid duplicate name errors in shadow DB)
CREATE UNIQUE INDEX IF NOT EXISTS "Like_userId_bookVersionId_key" ON "public"."Like"("userId", "bookVersionId");
