-- Add parentId column for Category hierarchy
ALTER TABLE "public"."Category"
  ADD COLUMN "parentId" TEXT;

-- Add self-referencing foreign key (SET NULL on delete)
ALTER TABLE "public"."Category"
  ADD CONSTRAINT "Category_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "public"."Category"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Index to speed up children lookups
CREATE INDEX IF NOT EXISTS "Category_parentId_idx" ON "public"."Category"("parentId");
