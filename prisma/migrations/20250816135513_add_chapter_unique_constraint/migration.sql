/*
  Warnings:

  - A unique constraint covering the columns `[bookVersionId,number]` on the table `Chapter` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Chapter_bookVersionId_number_key" ON "public"."Chapter"("bookVersionId", "number");
