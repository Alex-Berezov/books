-- Create unique index for BookCategory (bookVersionId, categoryId)
CREATE UNIQUE INDEX IF NOT EXISTS "BookCategory_bookVersionId_categoryId_key" ON "public"."BookCategory"("bookVersionId", "categoryId");
