-- ============================================================
-- Migration: add_page_content_fields
-- Date: 2026-07-06
-- Purpose:
--   1. Add h1 to Page (optional SEO heading)
--   2. Add shortDescription to Page (optional overview text)
--   3. Add faq to Page (optional JSON array for FAQ data)
-- ============================================================

-- Add h1 column to Page
ALTER TABLE "Page" ADD COLUMN "h1" TEXT;

-- Add shortDescription column to Page
ALTER TABLE "Page" ADD COLUMN "shortDescription" TEXT;

-- Add faq column to Page (JSON array of {question, answer})
ALTER TABLE "Page" ADD COLUMN "faq" JSONB;
