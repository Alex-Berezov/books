/*
  Warnings:

  - A unique constraint covering the columns `[userId,commentId]` on the table `Like` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[userId,bookVersionId]` on the table `Like` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateTable
CREATE TABLE "public"."Tag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BookTag" (
    "id" TEXT NOT NULL,
    "bookVersionId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "BookTag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tag_slug_key" ON "public"."Tag"("slug");

-- CreateIndex
CREATE INDEX "BookTag_tagId_idx" ON "public"."BookTag"("tagId");

-- CreateIndex
CREATE INDEX "BookTag_bookVersionId_idx" ON "public"."BookTag"("bookVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "BookTag_bookVersionId_tagId_key" ON "public"."BookTag"("bookVersionId", "tagId");

-- CreateIndex (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "Like_userId_commentId_key" ON "public"."Like"("userId", "commentId");

-- CreateIndex (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "Like_userId_bookVersionId_key" ON "public"."Like"("userId", "bookVersionId");

-- AddForeignKey
ALTER TABLE "public"."BookTag" ADD CONSTRAINT "BookTag_bookVersionId_fkey" FOREIGN KEY ("bookVersionId") REFERENCES "public"."BookVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BookTag" ADD CONSTRAINT "BookTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "public"."Tag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
