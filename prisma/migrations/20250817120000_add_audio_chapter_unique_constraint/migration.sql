-- Create unique index for AudioChapter (bookVersionId, number)
CREATE UNIQUE INDEX IF NOT EXISTS "AudioChapter_bookVersionId_number_key" ON "public"."AudioChapter"("bookVersionId", "number");
