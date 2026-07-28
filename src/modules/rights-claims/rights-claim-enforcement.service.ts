import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CLAIM_ACCESS_BLOCK_MESSAGE_RU,
  CLAIM_ACCESS_BLOCK_REASON_CODE,
} from './rights-claim.constants';
import {
  ClaimBlockScope,
  ClaimBookVersionDelegate,
  RightsClaimAccessBlockDelegate,
  RightsClaimAccessBlockRecord,
  RightsClaimBlockStatus,
} from './rights-claim-interface';

export interface ClaimAccessCheckInput {
  bookId?: string;
  bookVersionId?: string;
  countryCode: string | null;
  scope: ClaimBlockScope;
}

export interface ClaimAccessCheckResult {
  blocked: boolean;
  countryCode: string | null;
  scope: ClaimBlockScope;
  matchedBlockId: string | null;
  reasonCode: string | null;
  messageRu: string | null;
}

interface ClaimEnforcementDatabase {
  rightsClaimAccessBlock: RightsClaimAccessBlockDelegate;
  bookVersion: ClaimBookVersionDelegate;
}

/**
 * Runtime enforcement of temporary access blocks created from rights claims.
 *
 * The result never carries claim identifiers or claimant data — it only feeds the
 * generic 451 response body.
 */
@Injectable()
export class RightsClaimEnforcementService {
  constructor(private readonly prisma: PrismaService) {}

  private getDatabase(): ClaimEnforcementDatabase {
    return this.prisma as unknown as ClaimEnforcementDatabase;
  }

  async checkClaimAccess(input: ClaimAccessCheckInput): Promise<ClaimAccessCheckResult> {
    const database = this.getDatabase();
    const countryCode = input.countryCode ? input.countryCode.toUpperCase() : null;

    let bookId = input.bookId ?? null;
    if (!bookId && input.bookVersionId) {
      const version = await database.bookVersion.findUnique({
        where: { id: input.bookVersionId },
        select: { id: true, bookId: true, status: true },
      });
      bookId = version?.bookId ?? null;
    }

    const targetConditions: Array<Record<string, unknown>> = [];
    if (input.bookVersionId) targetConditions.push({ bookVersionId: input.bookVersionId });
    if (bookId) targetConditions.push({ bookId, scope: ClaimBlockScope.ENTIRE_BOOK });
    if (targetConditions.length === 0) return this.allowed(input, countryCode);

    const blocks = await database.rightsClaimAccessBlock.findMany({
      where: {
        status: RightsClaimBlockStatus.ACTIVE,
        OR: targetConditions,
      },
    });

    const matched = this.pickMatchingBlock(blocks, input.scope, countryCode);
    if (!matched) return this.allowed(input, countryCode);

    return {
      blocked: true,
      countryCode,
      scope: input.scope,
      matchedBlockId: matched.id,
      reasonCode: CLAIM_ACCESS_BLOCK_REASON_CODE,
      messageRu: matched.reasonRu || CLAIM_ACCESS_BLOCK_MESSAGE_RU,
    };
  }

  private pickMatchingBlock(
    blocks: RightsClaimAccessBlockRecord[],
    requestedScope: ClaimBlockScope,
    countryCode: string | null,
  ): RightsClaimAccessBlockRecord | null {
    const now = Date.now();

    const candidates = blocks.filter((block) => {
      if (block.status !== RightsClaimBlockStatus.ACTIVE) return false;
      // Expiry is evaluated at read time, so no cron is needed to retire blocks.
      if (block.expiresAt !== null && block.expiresAt.getTime() <= now) return false;
      if (!this.scopeCovers(block.scope, requestedScope)) return false;

      if (block.countryCode === null) return true;
      // Phase 12 policy: country-scoped restrictions never fire for an unknown country.
      if (countryCode === null) return false;
      return block.countryCode.toUpperCase() === countryCode;
    });

    if (candidates.length === 0) return null;

    return candidates.sort((left, right) => {
      const worldwide = this.worldwideRank(right) - this.worldwideRank(left);
      if (worldwide !== 0) return worldwide;
      return this.scopeRank(right.scope) - this.scopeRank(left.scope);
    })[0];
  }

  private scopeCovers(blockScope: ClaimBlockScope, requestedScope: ClaimBlockScope): boolean {
    if (blockScope === ClaimBlockScope.ENTIRE_BOOK) return true;
    if (blockScope === ClaimBlockScope.LANGUAGE_EDITION) return true;
    return blockScope === requestedScope;
  }

  private worldwideRank(block: RightsClaimAccessBlockRecord): number {
    return block.countryCode === null ? 1 : 0;
  }

  private scopeRank(scope: ClaimBlockScope): number {
    if (scope === ClaimBlockScope.ENTIRE_BOOK) return 3;
    if (scope === ClaimBlockScope.LANGUAGE_EDITION) return 2;
    return 1;
  }

  private allowed(
    input: ClaimAccessCheckInput,
    countryCode: string | null,
  ): ClaimAccessCheckResult {
    return {
      blocked: false,
      countryCode,
      scope: input.scope,
      matchedBlockId: null,
      reasonCode: null,
      messageRu: null,
    };
  }
}
