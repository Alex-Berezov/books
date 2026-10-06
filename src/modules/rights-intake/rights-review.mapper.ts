import type { RightsReviewColumnsDto } from './dto/rights-profile-response.dto';

/**
 * Единая проекция колонок `RightsReview` — и для `reviews` профиля (`RightsProfileService`),
 * и для истории проверок дашборда версии. Связи каждый вызывающий добавляет сам
 * (`LEGACY-183`, `T104j`: вторая рукописная копия разошлась бы с первой при первой же правке).
 */
export const mapRightsReviewColumns = (
  record: Record<string, unknown>,
): RightsReviewColumnsDto => ({
  id: record['id'] as string,
  rightsProfileId: record['rightsProfileId'] as string,
  rightsReviewImportId: record['rightsReviewImportId'] as string,
  status: record['status'] as string,
  schemaVersion: (record['schemaVersion'] as string | null) ?? null,
  reviewerType: record['reviewerType'] as string,
  overallStatus: record['overallStatus'] as string,
  publicationGate: record['publicationGate'] as string,
  confidence: record['confidence'] as string,
  summaryRu: record['summaryRu'] as string,
  conclusionRu: record['conclusionRu'] as string,
  reasoningRu: (record['reasoningRu'] as string | null) ?? null,
  nextReviewAt: record['nextReviewAt']
    ? new Date(record['nextReviewAt'] as string).toISOString()
    : null,
  // Phase 18: review history chain
  previousReviewId: (record['previousReviewId'] as string | null) ?? null,
  chainRootReviewId: (record['chainRootReviewId'] as string | null) ?? null,
  revisionNumber: (record['revisionNumber'] as number | null) ?? 1,
  approvedByUserId: (record['approvedByUserId'] as string | null) ?? null,
  approvedAt: record['approvedAt'] ? new Date(record['approvedAt'] as string).toISOString() : null,
  approvalNotesRu: (record['approvalNotesRu'] as string | null) ?? null,
  rejectedByUserId: (record['rejectedByUserId'] as string | null) ?? null,
  rejectedAt: record['rejectedAt'] ? new Date(record['rejectedAt'] as string).toISOString() : null,
  rejectionReasonRu: (record['rejectionReasonRu'] as string | null) ?? null,
  createdAt: new Date(record['createdAt'] as string).toISOString(),
  updatedAt: new Date(record['updatedAt'] as string).toISOString(),
});
