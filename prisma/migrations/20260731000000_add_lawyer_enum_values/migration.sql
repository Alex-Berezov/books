-- Phase 19: Lawyer Workflow — значения существующих enum'ов.
-- Отдельная миграция: PostgreSQL запрещает использовать новое значение enum'а
-- в той же транзакции, где оно добавлено (тот же приём, что в
-- 20260728000000_add_allowed_by_license_status и 20260730000000_add_recheck_notification_types).
--
-- Применять ПЕРЕД 20260731000100_add_lawyer_workflow.

ALTER TYPE "RoleName" ADD VALUE IF NOT EXISTS 'lawyer';

ALTER TYPE "RightsIntakeStatus"  ADD VALUE IF NOT EXISTS 'LAWYER_REVIEW_REQUIRED';
ALTER TYPE "RightsReviewStatus"  ADD VALUE IF NOT EXISTS 'LAWYER_REVIEW_REQUIRED';
ALTER TYPE "RightsReviewStatus"  ADD VALUE IF NOT EXISTS 'LAWYER_APPROVED';
ALTER TYPE "RightsProfileStatus" ADD VALUE IF NOT EXISTS 'LAWYER_REVIEW_REQUIRED';
ALTER TYPE "RightsProfileStatus" ADD VALUE IF NOT EXISTS 'LAWYER_APPROVED';

ALTER TYPE "RightsNotificationType" ADD VALUE IF NOT EXISTS 'LAWYER_REVIEW_ASSIGNED';
ALTER TYPE "RightsNotificationType" ADD VALUE IF NOT EXISTS 'LAWYER_REVIEW_APPROVED';
ALTER TYPE "RightsNotificationType" ADD VALUE IF NOT EXISTS 'LAWYER_REVIEW_REJECTED';
ALTER TYPE "RightsNotificationType" ADD VALUE IF NOT EXISTS 'LAWYER_REVIEW_WITHDRAWN';
ALTER TYPE "RightsNotificationType" ADD VALUE IF NOT EXISTS 'LAWYER_OPINION_EXPIRING';
ALTER TYPE "RightsNotificationType" ADD VALUE IF NOT EXISTS 'LAWYER_OPINION_EXPIRED';
