import { GeoBlockScope, RightsClaimBlockStatus, RightsClaimStatus } from '@prisma/client';
import { scopesCovering, settledClaimBlockWhere } from './settled-claim-block';

/**
 * Общее условие «действующий блок окончённой претензии» (F03-2, решение арбитра `F03 | F03-2`):
 * одно на ручку анализа, счётчик `_count.analyses` и список закрытий. Литерал прибит здесь -
 * сдвиг одной стороны краснеет у всех трёх потребителей сразу.
 */
describe('settled-claim-block', () => {
  it('scopesCovering: книга и языковое издание закрывают всё, остальное - только свою область', () => {
    expect(scopesCovering(GeoBlockScope.TEXT_READER)).toEqual([
      GeoBlockScope.ENTIRE_BOOK,
      GeoBlockScope.LANGUAGE_EDITION,
      GeoBlockScope.TEXT_READER,
    ]);
    expect(scopesCovering(GeoBlockScope.ENTIRE_BOOK)).toEqual([
      GeoBlockScope.ENTIRE_BOOK,
      GeoBlockScope.LANGUAGE_EDITION,
    ]);
  });

  it('settledClaimBlockWhere: ACTIVE, область, не истёк к моменту, претензия в конечном статусе', () => {
    const now = new Date('2026-10-18T12:00:00Z');
    expect(settledClaimBlockWhere(now, GeoBlockScope.TEXT_READER)).toEqual({
      status: RightsClaimBlockStatus.ACTIVE,
      scope: {
        in: [GeoBlockScope.ENTIRE_BOOK, GeoBlockScope.LANGUAGE_EDITION, GeoBlockScope.TEXT_READER],
      },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      rightsClaim: {
        status: {
          in: [
            RightsClaimStatus.RESOLVED_VALID,
            RightsClaimStatus.RESOLVED_INVALID,
            RightsClaimStatus.WITHDRAWN,
            RightsClaimStatus.CLOSED,
          ],
        },
      },
    });
  });
});
