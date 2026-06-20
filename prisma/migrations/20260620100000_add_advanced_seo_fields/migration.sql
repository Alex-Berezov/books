-- AlterTable
ALTER TABLE "BookVersion" ADD COLUMN     "originalTitle" TEXT,
ADD COLUMN     "alternativeTitles" JSONB,
ADD COLUMN     "shortDescription" TEXT,
ADD COLUMN     "summaryShort" TEXT,
ADD COLUMN     "symbols" JSONB,
ADD COLUMN     "coverAlt" TEXT;
