-- AlterTable
ALTER TABLE "public"."Comment" ADD COLUMN     "isDeleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isHidden" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Comment_bookVersionId_idx" ON "public"."Comment"("bookVersionId");

-- CreateIndex
CREATE INDEX "Comment_chapterId_idx" ON "public"."Comment"("chapterId");

-- CreateIndex
CREATE INDEX "Comment_audioChapterId_idx" ON "public"."Comment"("audioChapterId");

-- CreateIndex
CREATE INDEX "Comment_parentId_idx" ON "public"."Comment"("parentId");
