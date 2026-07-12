-- ============================================================
-- Migration: add_homepage_sections
-- Date: 2026-07-12
-- Purpose:
--   1. Add 'homepage' to PageType enum
--   2. Add sections JSON field to Page model
-- ============================================================

-- ALTER TYPE ... ADD VALUE must run outside a transaction block
-- Prisma runs each statement in its own implicit transaction
ALTER TYPE "PageType" ADD VALUE 'homepage';

-- Add sections JSON column to Page (stores homepage block data)
ALTER TABLE "Page" ADD COLUMN "sections" JSONB;
