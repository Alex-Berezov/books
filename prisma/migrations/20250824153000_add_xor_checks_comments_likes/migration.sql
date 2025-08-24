-- Cleanup invalid Comment rows before adding CHECK (keep dev DB consistent)
DELETE FROM "Comment"
WHERE num_nonnulls("bookVersionId", "chapterId", "audioChapterId") <> 1;

-- Ensure exactly one target is set for comments: bookVersionId XOR chapterId XOR audioChapterId
ALTER TABLE "Comment"
  ADD CONSTRAINT "comment_target_xor_chk"
  CHECK (num_nonnulls("bookVersionId", "chapterId", "audioChapterId") = 1);

-- Cleanup invalid Like rows
DELETE FROM "Like"
WHERE num_nonnulls("bookVersionId", "commentId") <> 1;

-- Ensure exactly one target is set for likes: bookVersionId XOR commentId
ALTER TABLE "Like"
  ADD CONSTRAINT "like_target_xor_chk"
  CHECK (num_nonnulls("bookVersionId", "commentId") = 1);
