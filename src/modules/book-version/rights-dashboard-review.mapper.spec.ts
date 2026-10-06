import type { RightsReview } from '@prisma/client';
import { mapDashboardReview } from './rights-dashboard-review.mapper';

// Каждое поле со своим значением: перестановка двух полей в маппере даёт красное.
const row = {
  id: 'review-1',
  rightsProfileId: 'profile-1',
  rightsReviewImportId: 'import-1',
  status: 'APPROVED',
  schemaVersion: '1.0',
  reviewerType: 'EXTERNAL_CHATGPT_AGENT',
  promptVersion: 'prompt-3',
  agentModel: 'agent-model',
  overallStatus: 'PUBLISHABLE',
  publicationGate: 'ALLOW',
  confidence: 'HIGH',
  summaryRu: 'Сводка',
  conclusionRu: 'Заключение',
  reasoningRu: 'Обоснование',
  nextReviewAt: new Date('2027-01-01T00:00:00Z'),
  previousReviewId: 'review-0',
  chainRootReviewId: 'review-root',
  revisionNumber: 3,
  approvedByUserId: 'user-approver',
  approvedAt: new Date('2026-07-02T00:00:00Z'),
  approvalNotesRu: 'Утверждено',
  rejectedByUserId: 'user-rejecter',
  rejectedAt: new Date('2026-07-03T00:00:00Z'),
  rejectionReasonRu: 'Отклонено',
  staleDetectedAt: null,
  staleReasonCode: null,
  staleReasonRu: null,
  lawyerReviewRequired: true,
  lawyerReviewId: 'lawyer-review-1',
  lawyerApprovedAt: new Date('2026-07-04T00:00:00Z'),
  lawyerNameSnapshot: 'Иванова А. С.',
  createdAt: new Date('2026-07-01T00:00:00Z'),
  updatedAt: new Date('2026-07-05T00:00:00Z'),
} as unknown as RightsReview;

describe('mapDashboardReview', () => {
  it('отдаёт каждую колонку своим полем, даты строкой ISO, без связей и служебных колонок', () => {
    expect(mapDashboardReview(row)).toEqual({
      id: 'review-1',
      rightsProfileId: 'profile-1',
      rightsReviewImportId: 'import-1',
      status: 'APPROVED',
      schemaVersion: '1.0',
      reviewerType: 'EXTERNAL_CHATGPT_AGENT',
      overallStatus: 'PUBLISHABLE',
      publicationGate: 'ALLOW',
      confidence: 'HIGH',
      summaryRu: 'Сводка',
      conclusionRu: 'Заключение',
      reasoningRu: 'Обоснование',
      nextReviewAt: '2027-01-01T00:00:00.000Z',
      previousReviewId: 'review-0',
      chainRootReviewId: 'review-root',
      revisionNumber: 3,
      approvedByUserId: 'user-approver',
      approvedAt: '2026-07-02T00:00:00.000Z',
      approvalNotesRu: 'Утверждено',
      rejectedByUserId: 'user-rejecter',
      rejectedAt: '2026-07-03T00:00:00.000Z',
      rejectionReasonRu: 'Отклонено',
      lawyerReviewRequired: true,
      lawyerReviewId: 'lawyer-review-1',
      lawyerApprovedAt: '2026-07-04T00:00:00.000Z',
      lawyerNameSnapshot: 'Иванова А. С.',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-05T00:00:00.000Z',
    });
  });

  it('пустые даты отдаёт null', () => {
    const mapped = mapDashboardReview({
      ...row,
      nextReviewAt: null,
      approvedAt: null,
      rejectedAt: null,
      lawyerApprovedAt: null,
    });
    expect(mapped).toMatchObject({
      nextReviewAt: null,
      approvedAt: null,
      rejectedAt: null,
      lawyerApprovedAt: null,
    });
  });

  it('пустые необязательные колонки отдаёт null, номер ревизии по умолчанию — 1', () => {
    const mapped = mapDashboardReview({
      ...row,
      schemaVersion: null,
      reasoningRu: null,
      previousReviewId: null,
      chainRootReviewId: null,
      revisionNumber: null,
    } as unknown as RightsReview);
    expect(mapped).toMatchObject({
      schemaVersion: null,
      reasoningRu: null,
      previousReviewId: null,
      chainRootReviewId: null,
      revisionNumber: 1,
    });
  });
});
