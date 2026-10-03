import type { RightsApprovalDecision } from '@prisma/client';
import type { DecidedByUserDto, RightsReviewApprovalDto } from './dto/rights-review-approval.dto';

/**
 * Пользователь из `select: { id, name, email }`. `User.name` в схеме nullable, а DTO объявляет
 * `name?: string` — пустое имя уходит отсутствующим ключом, а не `null` (`LEGACY-016`, `T91`).
 */
export const mapDecidedByUser = (raw: Record<string, unknown> | null): DecidedByUserDto | null =>
  raw
    ? {
        id: raw['id'] as string,
        name: (raw['name'] as string | null) ?? undefined,
        email: raw['email'] as string,
      }
    : null;

/** Единая проекция `RightsReviewApproval` в DTO — и для ручек решений, и для `mapReview` профиля. */
export const mapRightsReviewApproval = (
  record: Record<string, unknown>,
): RightsReviewApprovalDto => ({
  id: record['id'] as string,
  rightsReviewId: record['rightsReviewId'] as string,
  rightsProfileId: record['rightsProfileId'] as string,
  rightsIntakeId: record['rightsIntakeId'] as string,
  decision: record['decision'] as RightsApprovalDecision,
  decidedByUser: mapDecidedByUser(record['decidedByUser'] as Record<string, unknown> | null),
  notesRu: (record['notesRu'] as string | null) ?? null,
  createdAt: new Date(record['createdAt'] as string).toISOString(),
});
