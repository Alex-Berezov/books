/*
  Warnings:

  - A unique constraint covering the columns `[userId,commentId]` on the table `Like` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[userId,bookVersionId]` on the table `Like` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Like_userId_commentId_key" ON "public"."Like"("userId", "commentId");

-- CreateIndex
CREATE UNIQUE INDEX "Like_userId_bookVersionId_key" ON "public"."Like"("userId", "bookVersionId");
