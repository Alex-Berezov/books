import type { RightsReview } from '@prisma/client';
import { mapRightsReviewColumns } from '../rights-intake/rights-review.mapper';
import type { BookRightsDashboardReviewDto } from './dto/rights-dashboard-review.dto';

/**
 * Строка `RightsReview` в форму истории проверок дашборда: общая проекция колонок
 * (`mapRightsReviewColumns`, та же, что у `reviews` профиля) плюс снимок юриста.
 */
export const mapDashboardReview = (row: RightsReview): BookRightsDashboardReviewDto => ({
  ...mapRightsReviewColumns(row as unknown as Record<string, unknown>),
  // Phase 19: снимок юридического утверждения
  lawyerReviewRequired: row.lawyerReviewRequired,
  lawyerReviewId: row.lawyerReviewId,
  lawyerApprovedAt: row.lawyerApprovedAt ? row.lawyerApprovedAt.toISOString() : null,
  lawyerNameSnapshot: row.lawyerNameSnapshot,
});
