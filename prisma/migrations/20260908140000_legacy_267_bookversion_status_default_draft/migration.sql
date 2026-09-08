-- LEGACY-267: BookVersion.status defaulted to 'published', opposite of what the
-- product needs (draft). The application write path (book-version.service.ts,
-- rights-book-creation.service.ts) already sets 'draft' explicitly; prisma/seed.ts
-- relied on the schema default and is fixed in the same commit to set 'published'
-- explicitly, since its rows are meant to be publicly visible sample data. This
-- migration only fixes the schema default for any future write path that forgets
-- to set the column. Existing rows are not touched.
ALTER TABLE "BookVersion" ALTER COLUMN "status" SET DEFAULT 'draft';
