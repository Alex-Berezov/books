import { PrismaClient } from '@prisma/client';
import { RightsContentHashService } from '../../src/modules/rights-intake/rights-content-hash.service';

/**
 * Helper для e2e тестов: сбрасывает stale статус и пересоздаёт baseline hash для всех версий книги.
 * Используется после изменения контента (например, добавления audio chapter), чтобы симулировать
 * "новый approved clearance" и позволить публикацию в тестах, которые не проверяют права.
 */
export async function markBookRightsFreshForTests(
  prisma: PrismaClient,
  bookId: string,
  rightsContentHashService: RightsContentHashService,
): Promise<void> {
  const versions = await prisma.bookVersion.findMany({
    where: { bookId },
    select: {
      id: true,
      rightsProfileId: true,
      approvedRightsReviewId: true,
    },
  });

  if (versions.length === 0) return;

  const first = versions[0];

  // Сбросить stale статус для RightsProfile
  if (first.rightsProfileId) {
    await prisma.rightsProfile.update({
      where: { id: first.rightsProfileId },
      data: {
        status: 'APPROVED',
        staleDetectedAt: null,
        staleReasonCode: null,
        staleReasonRu: null,
      },
    });
  }

  // Сбросить stale статус для RightsReview
  if (first.approvedRightsReviewId) {
    await prisma.rightsReview.update({
      where: { id: first.approvedRightsReviewId },
      data: {
        status: 'HUMAN_APPROVED',
        staleDetectedAt: null,
        staleReasonCode: null,
        staleReasonRu: null,
      },
    });
  }

  // Пересоздать baseline hash для всех версий
  for (const version of versions) {
    await rightsContentHashService.initializeVersionBaseline(
      version.id,
      'INITIAL_VERSION_SNAPSHOT',
      null,
    );
  }
}
