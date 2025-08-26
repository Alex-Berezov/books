-- CreateTable MediaAsset (idempotent where safe)
DO $$ BEGIN
  CREATE TABLE IF NOT EXISTS "public"."MediaAsset" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "contentType" TEXT,
    "size" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "hash" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
  );
EXCEPTION WHEN duplicate_table THEN NULL; END $$;

-- Unique index on key
CREATE UNIQUE INDEX IF NOT EXISTS "MediaAsset_key_key" ON "public"."MediaAsset"("key");

-- Indexes
CREATE INDEX IF NOT EXISTS "MediaAsset_createdAt_idx" ON "public"."MediaAsset"("createdAt");
CREATE INDEX IF NOT EXISTS "MediaAsset_hash_idx" ON "public"."MediaAsset"("hash");
CREATE INDEX IF NOT EXISTS "MediaAsset_createdById_idx" ON "public"."MediaAsset"("createdById");

-- Foreign key to User (createdById)
DO $$ BEGIN
  ALTER TABLE "public"."MediaAsset"
  ADD CONSTRAINT "MediaAsset_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
