-- Phase 18: notification types for automatic recheck.
-- Kept in a separate migration: PostgreSQL forbids using a new enum value in the
-- same transaction that added it (same reason as 20260728000000_add_allowed_by_license_status).
ALTER TYPE "RightsNotificationType" ADD VALUE IF NOT EXISTS 'RECHECK_OVERDUE';
ALTER TYPE "RightsNotificationType" ADD VALUE IF NOT EXISTS 'RECHECK_TASK_OPENED';
ALTER TYPE "RightsNotificationType" ADD VALUE IF NOT EXISTS 'RECHECK_COMPLETED';
ALTER TYPE "RightsNotificationType" ADD VALUE IF NOT EXISTS 'LEGAL_CHANGE_APPLIED';
