import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  GeoAccessCheckResultDto,
  GeoBlockRuleDto,
  GeoBlockRulesResponseDto,
  GeoBlockScope,
  VerifyGeoBlockRulesDto,
} from './dto/geo-block.dto';

export interface GeoAccessCheckInput {
  bookId?: string;
  bookVersionId?: string;
  mediaAssetId?: string;
  countryCode: string | null;
  scope: GeoBlockScope;
}

interface GeoBlockRuleRecord {
  id: string;
  bookId: string | null;
  bookVersionId: string | null;
  rightsProfileId: string | null;
  territoryDecisionId: string | null;
  scope: GeoBlockScope;
  countryCode: string;
  accessPolicy: string;
  sourceFinalStatus: string | null;
  isActive: boolean;
  reasonRu: string | null;
  legalBasisRu: string | null;
  generatedFrom: string;
  generatedAt: Date;
  verifiedAt: Date | null;
  verifiedByUserId: string | null;
  verificationNotesRu: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface GeoBlockRuleDelegate {
  findMany(args: Record<string, unknown>): Promise<GeoBlockRuleRecord[]>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  upsert(args: Record<string, unknown>): Promise<GeoBlockRuleRecord>;
}

interface DynamicBookVersionDelegate {
  update(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

interface GeoBlockDatabaseClient {
  geoBlockRule: GeoBlockRuleDelegate;
  bookVersion: DynamicBookVersionDelegate;
  $transaction<T>(callback: (client: GeoBlockDatabaseClient) => Promise<T>): Promise<T>;
}

interface BookVersionGeoBlockState {
  id: string;
  bookId: string;
  rightsProfileId: string | null;
  rightsGeoBlockRequired: boolean;
  rightsGeoBlockConfigured: boolean;
  rightsGeoBlockVerifiedAt: Date | null;
  rightsGeoBlockLastGeneratedAt: Date | null;
}

const GEO_BLOCK_REASON_CODE = 'GEO_BLOCKED_BY_RIGHTS';
const GEO_BLOCK_MESSAGE = 'Content is not available in your country due to rights restrictions.';
const GEO_BLOCK_MESSAGE_RU = 'Контент недоступен в вашей стране из-за ограничений прав.';

@Injectable()
export class GeoBlockRuleService {
  private readonly logger = new Logger(GeoBlockRuleService.name);

  constructor(private readonly prisma: PrismaService) {}

  async generateRulesForVersion(bookVersionId: string): Promise<GeoBlockRulesResponseDto> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: { id: true, bookId: true, rightsProfileId: true },
    });
    if (!version) throw new NotFoundException('BookVersion not found');
    if (!version.rightsProfileId) {
      throw new BadRequestException('Cannot generate geo-block rules without a rights profile');
    }

    const territoryDecisions = await this.prisma.territoryDecision.findMany({
      where: { rightsProfileId: version.rightsProfileId },
    });
    const blockedDecisions = territoryDecisions.filter(
      (decision) =>
        decision.finalStatus === 'BLOCKED' ||
        decision.accessPolicy === 'BLOCK' ||
        decision.geoBlockRequired,
    );
    const generatedAt = new Date();
    const database = this.getDatabase();

    await database.$transaction(async (transaction) => {
      await transaction.geoBlockRule.updateMany({
        where: { bookVersionId, isActive: true },
        data: { isActive: false },
      });

      for (const decision of blockedDecisions) {
        const scope = this.resolveScope(decision.geoBlockScope);
        const countryCode = decision.countryCode.toUpperCase();
        const ruleData = {
          bookId: version.bookId,
          bookVersionId,
          rightsProfileId: version.rightsProfileId,
          territoryDecisionId: decision.id,
          scope,
          countryCode,
          accessPolicy: decision.accessPolicy,
          sourceFinalStatus: decision.finalStatus,
          isActive: true,
          reasonRu: decision.reasonRu,
          legalBasisRu: decision.legalBasisRu,
          generatedFrom: 'TERRITORY_DECISION',
          generatedAt,
          verifiedAt: null,
          verifiedByUserId: null,
          verificationNotesRu: null,
        };

        await transaction.geoBlockRule.upsert({
          where: {
            bookVersionId_scope_countryCode: {
              bookVersionId,
              scope,
              countryCode,
            },
          },
          create: ruleData,
          update: ruleData,
        });
      }

      await transaction.bookVersion.update({
        where: { id: bookVersionId },
        data: {
          rightsGeoBlockConfigured: false,
          rightsGeoBlockConfiguredAt: null,
          rightsGeoBlockVerifiedAt: null,
          rightsGeoBlockVerifiedByUserId: null,
          rightsGeoBlockLastGeneratedAt: generatedAt,
        },
      });
    });

    return this.getRulesForVersion(bookVersionId);
  }

  async getRulesForVersion(bookVersionId: string): Promise<GeoBlockRulesResponseDto> {
    const version = await this.getVersionState(bookVersionId);
    const rules = await this.getDatabase().geoBlockRule.findMany({
      where: { bookVersionId },
      orderBy: [{ isActive: 'desc' }, { countryCode: 'asc' }, { scope: 'asc' }],
    });
    const ruleDtos = rules.map((rule) => this.mapRule(rule));
    const activeRules = rules.filter((rule) => rule.isActive);

    return {
      bookVersionId,
      rules: ruleDtos,
      summary: {
        geoBlockRequired: version.rightsGeoBlockRequired,
        configured: version.rightsGeoBlockConfigured,
        verifiedAt: this.toIso(version.rightsGeoBlockVerifiedAt),
        lastGeneratedAt: this.toIso(version.rightsGeoBlockLastGeneratedAt),
        totalRulesCount: rules.length,
        activeRulesCount: activeRules.length,
        verifiedRulesCount: activeRules.filter((rule) => rule.verifiedAt !== null).length,
        blockedCountries: Array.from(new Set(activeRules.map((rule) => rule.countryCode))).sort(),
        scopes: Array.from(new Set(activeRules.map((rule) => rule.scope))).sort(),
      },
    };
  }

  async verifyRulesForVersion(
    bookVersionId: string,
    dto: VerifyGeoBlockRulesDto,
    userId: string,
  ): Promise<GeoBlockRulesResponseDto> {
    const version = await this.getVersionState(bookVersionId);
    const database = this.getDatabase();
    const activeRules = await database.geoBlockRule.findMany({
      where: { bookVersionId, isActive: true },
    });

    if (dto.verified && version.rightsGeoBlockRequired && activeRules.length === 0) {
      throw new BadRequestException('Cannot verify geo-block: no active rules were generated');
    }

    const verifiedAt = dto.verified ? new Date() : null;
    await database.$transaction(async (transaction) => {
      await transaction.geoBlockRule.updateMany({
        where: { bookVersionId, isActive: true },
        data: {
          verifiedAt,
          verifiedByUserId: dto.verified ? userId : null,
          verificationNotesRu: dto.notesRu ?? null,
        },
      });
      await transaction.bookVersion.update({
        where: { id: bookVersionId },
        data: {
          rightsGeoBlockConfigured: dto.verified,
          rightsGeoBlockConfiguredAt: verifiedAt,
          rightsGeoBlockVerifiedAt: verifiedAt,
          rightsGeoBlockVerifiedByUserId: dto.verified ? userId : null,
          rightsGeoBlockNotesRu: dto.notesRu ?? null,
        },
      });
    });

    return this.getRulesForVersion(bookVersionId);
  }

  async checkAccess(input: GeoAccessCheckInput): Promise<GeoAccessCheckResultDto> {
    if (!input.countryCode) {
      this.logger.warn(
        `GeoIP country is unknown for scope ${input.scope}; allowing access by Phase 12 policy`,
      );
      return this.allowedResult(input, 'UNKNOWN');
    }

    const countryCode = input.countryCode.toUpperCase();
    const version = input.bookVersionId
      ? await this.prisma.bookVersion.findUnique({
          where: { id: input.bookVersionId },
          select: { id: true, bookId: true },
        })
      : null;
    if (input.bookVersionId && !version) throw new NotFoundException('BookVersion not found');

    const bookId = input.bookId ?? version?.bookId;
    const conditions: Array<Record<string, unknown>> = [];
    if (bookId) conditions.push({ bookId, scope: GeoBlockScope.ENTIRE_BOOK });
    if (input.bookVersionId) {
      conditions.push({
        bookVersionId: input.bookVersionId,
        scope: GeoBlockScope.LANGUAGE_EDITION,
      });
      conditions.push({ bookVersionId: input.bookVersionId, scope: input.scope });
    }

    if (conditions.length === 0) return this.allowedResult(input, countryCode);

    const matchedRules = await this.getDatabase().geoBlockRule.findMany({
      where: {
        isActive: true,
        countryCode,
        OR: conditions,
      },
    });
    const matchedRule = matchedRules.sort(
      (left, right) => this.scopeRank(right.scope) - this.scopeRank(left.scope),
    )[0];
    if (!matchedRule) return this.allowedResult(input, countryCode);

    return {
      allowed: false,
      countryCode,
      scope: input.scope,
      matchedRuleId: matchedRule.id,
      reasonCode: GEO_BLOCK_REASON_CODE,
      messageRu: matchedRule.reasonRu || GEO_BLOCK_MESSAGE_RU,
      bookVersionId: input.bookVersionId ?? null,
    };
  }

  async assertAccess(input: GeoAccessCheckInput): Promise<void> {
    const result = await this.checkAccess(input);
    if (result.allowed) return;

    throw new HttpException(
      {
        statusCode: 451,
        code: GEO_BLOCK_REASON_CODE,
        message: GEO_BLOCK_MESSAGE,
        messageRu: GEO_BLOCK_MESSAGE_RU,
        countryCode: result.countryCode,
        scope: result.scope,
      },
      451,
    );
  }

  async getActiveRulesForVersion(bookVersionId: string): Promise<GeoBlockRuleDto[]> {
    const rules = await this.getDatabase().geoBlockRule.findMany({
      where: { bookVersionId, isActive: true },
      orderBy: [{ countryCode: 'asc' }, { scope: 'asc' }],
    });
    return rules.map((rule) => this.mapRule(rule));
  }

  private getDatabase(): GeoBlockDatabaseClient {
    return this.prisma as unknown as GeoBlockDatabaseClient;
  }

  private async getVersionState(bookVersionId: string): Promise<BookVersionGeoBlockState> {
    const rawVersion = await this.prisma.bookVersion.findUnique({
      where: { id: bookVersionId },
    });
    if (!rawVersion) throw new NotFoundException('BookVersion not found');
    const version = rawVersion as unknown as Partial<BookVersionGeoBlockState>;

    return {
      id: rawVersion.id,
      bookId: rawVersion.bookId,
      rightsProfileId: rawVersion.rightsProfileId,
      rightsGeoBlockRequired: rawVersion.rightsGeoBlockRequired,
      rightsGeoBlockConfigured: rawVersion.rightsGeoBlockConfigured,
      rightsGeoBlockVerifiedAt: version.rightsGeoBlockVerifiedAt ?? null,
      rightsGeoBlockLastGeneratedAt: version.rightsGeoBlockLastGeneratedAt ?? null,
    };
  }

  private resolveScope(value: string | null): GeoBlockScope {
    if (value && Object.values(GeoBlockScope).includes(value as GeoBlockScope)) {
      return value as GeoBlockScope;
    }
    return GeoBlockScope.LANGUAGE_EDITION;
  }

  private scopeRank(scope: GeoBlockScope): number {
    if (scope === GeoBlockScope.ENTIRE_BOOK) return 3;
    if (scope === GeoBlockScope.LANGUAGE_EDITION) return 2;
    return 1;
  }

  private allowedResult(input: GeoAccessCheckInput, countryCode: string): GeoAccessCheckResultDto {
    return {
      allowed: true,
      countryCode,
      scope: input.scope,
      matchedRuleId: null,
      reasonCode: null,
      messageRu: null,
      bookVersionId: input.bookVersionId ?? null,
    };
  }

  private mapRule(rule: GeoBlockRuleRecord): GeoBlockRuleDto {
    return {
      id: rule.id,
      bookId: rule.bookId,
      bookVersionId: rule.bookVersionId,
      rightsProfileId: rule.rightsProfileId,
      territoryDecisionId: rule.territoryDecisionId,
      scope: rule.scope,
      countryCode: rule.countryCode,
      accessPolicy: rule.accessPolicy,
      sourceFinalStatus: rule.sourceFinalStatus,
      isActive: rule.isActive,
      reasonRu: rule.reasonRu,
      legalBasisRu: rule.legalBasisRu,
      generatedFrom: rule.generatedFrom,
      generatedAt: rule.generatedAt.toISOString(),
      verifiedAt: this.toIso(rule.verifiedAt),
      verifiedByUserId: rule.verifiedByUserId,
      verificationNotesRu: rule.verificationNotesRu,
      createdAt: rule.createdAt.toISOString(),
      updatedAt: rule.updatedAt.toISOString(),
    };
  }

  private toIso(value: Date | null): string | null {
    return value ? value.toISOString() : null;
  }
}
