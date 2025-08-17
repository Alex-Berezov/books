-- CreateIndex
CREATE UNIQUE INDEX "Bookshelf_userId_bookVersionId_key" ON "public"."Bookshelf"("userId", "bookVersionId");
