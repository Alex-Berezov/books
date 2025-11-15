-- Add CASCADE delete for all BookVersion relations
-- This ensures that when a Book is deleted, all related data is automatically removed

-- BookVersion -> Book
ALTER TABLE "BookVersion" DROP CONSTRAINT "BookVersion_bookId_fkey";
ALTER TABLE "BookVersion" ADD CONSTRAINT "BookVersion_bookId_fkey" 
  FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- BookSummary -> BookVersion
ALTER TABLE "BookSummary" DROP CONSTRAINT "BookSummary_bookVersionId_fkey";
ALTER TABLE "BookSummary" ADD CONSTRAINT "BookSummary_bookVersionId_fkey" 
  FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Chapter -> BookVersion
ALTER TABLE "Chapter" DROP CONSTRAINT "Chapter_bookVersionId_fkey";
ALTER TABLE "Chapter" ADD CONSTRAINT "Chapter_bookVersionId_fkey" 
  FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AudioChapter -> BookVersion
ALTER TABLE "AudioChapter" DROP CONSTRAINT "AudioChapter_bookVersionId_fkey";
ALTER TABLE "AudioChapter" ADD CONSTRAINT "AudioChapter_bookVersionId_fkey" 
  FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Bookshelf -> BookVersion
ALTER TABLE "Bookshelf" DROP CONSTRAINT "Bookshelf_bookVersionId_fkey";
ALTER TABLE "Bookshelf" ADD CONSTRAINT "Bookshelf_bookVersionId_fkey" 
  FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Comment -> BookVersion (optional relation, CASCADE to remove orphaned comments)
ALTER TABLE "Comment" DROP CONSTRAINT IF EXISTS "Comment_bookVersionId_fkey";
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_bookVersionId_fkey" 
  FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Comment -> Chapter (CASCADE to remove chapter comments when chapter is deleted)
ALTER TABLE "Comment" DROP CONSTRAINT IF EXISTS "Comment_chapterId_fkey";
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_chapterId_fkey" 
  FOREIGN KEY ("chapterId") REFERENCES "Chapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Comment -> AudioChapter (CASCADE to remove audio chapter comments when audio chapter is deleted)
ALTER TABLE "Comment" DROP CONSTRAINT IF EXISTS "Comment_audioChapterId_fkey";
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_audioChapterId_fkey" 
  FOREIGN KEY ("audioChapterId") REFERENCES "AudioChapter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Like -> BookVersion
ALTER TABLE "Like" DROP CONSTRAINT IF EXISTS "Like_bookVersionId_fkey";
ALTER TABLE "Like" ADD CONSTRAINT "Like_bookVersionId_fkey" 
  FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Like -> Comment
ALTER TABLE "Like" DROP CONSTRAINT IF EXISTS "Like_commentId_fkey";
ALTER TABLE "Like" ADD CONSTRAINT "Like_commentId_fkey" 
  FOREIGN KEY ("commentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- BookCategory -> BookVersion
ALTER TABLE "BookCategory" DROP CONSTRAINT "BookCategory_bookVersionId_fkey";
ALTER TABLE "BookCategory" ADD CONSTRAINT "BookCategory_bookVersionId_fkey" 
  FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- BookTag -> BookVersion
ALTER TABLE "BookTag" DROP CONSTRAINT "BookTag_bookVersionId_fkey";
ALTER TABLE "BookTag" ADD CONSTRAINT "BookTag_bookVersionId_fkey" 
  FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ViewStat -> BookVersion
ALTER TABLE "ViewStat" DROP CONSTRAINT "ViewStat_bookVersionId_fkey";
ALTER TABLE "ViewStat" ADD CONSTRAINT "ViewStat_bookVersionId_fkey" 
  FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ReadingProgress -> BookVersion
ALTER TABLE "ReadingProgress" DROP CONSTRAINT "ReadingProgress_bookVersionId_fkey";
ALTER TABLE "ReadingProgress" ADD CONSTRAINT "ReadingProgress_bookVersionId_fkey" 
  FOREIGN KEY ("bookVersionId") REFERENCES "BookVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
