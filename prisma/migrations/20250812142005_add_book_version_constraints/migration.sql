/*
  Warnings:

  - A unique constraint covering the columns `[bookId,language]` on the table `BookVersion` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE INDEX "book_language_type_isFree_idx" ON "public"."BookVersion"("bookId", "language", "type", "isFree");

-- CreateIndex
CREATE UNIQUE INDEX "BookVersion_bookId_language_key" ON "public"."BookVersion"("bookId", "language");
