-- AlterTable
ALTER TABLE "BookVersion" ADD COLUMN     "originalLanguage" TEXT,
ADD COLUMN     "copyrightStatus" TEXT,
ADD COLUMN     "authorPageUrl" TEXT,
ADD COLUMN     "characters" JSONB,
ADD COLUMN     "quotes" JSONB,
ADD COLUMN     "faq" JSONB,
ADD COLUMN     "themes" JSONB;
