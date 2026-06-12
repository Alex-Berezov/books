-- AlterTable
ALTER TABLE "User" ADD COLUMN "nickname" TEXT;

-- AlterTable
ALTER TABLE "Comment" ADD COLUMN "ratingId" TEXT;

-- AlterTable
ALTER TABLE "Like" ADD COLUMN "isLike" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE UNIQUE INDEX "User_nickname_key" ON "User"("nickname");

-- CreateIndex
CREATE UNIQUE INDEX "Comment_ratingId_key" ON "Comment"("ratingId");

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_ratingId_fkey" FOREIGN KEY ("ratingId") REFERENCES "BookRating"("id") ON DELETE SET NULL ON UPDATE CASCADE;
