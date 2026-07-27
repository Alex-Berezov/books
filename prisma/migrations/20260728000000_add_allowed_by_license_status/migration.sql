-- Phase 15: add ALLOWED_BY_LICENSE to TerritoryRightsStatus.
-- PostgreSQL forbids using a newly added enum value in the same transaction block,
-- so this ALTER TYPE lives in its own migration, applied before 20260728000100_add_rights_licenses.

-- AlterEnum
ALTER TYPE "TerritoryRightsStatus" ADD VALUE IF NOT EXISTS 'ALLOWED_BY_LICENSE';
