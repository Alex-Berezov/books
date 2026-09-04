import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GeoBlockRule, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsClaimEnforcementService } from '../rights-claims/rights-claim-enforcement.service';
import {
  CLAIM_ACCESS_BLOCK_MESSAGE,
  CLAIM_ACCESS_BLOCK_MESSAGE_RU,
  CLAIM_ACCESS_BLOCK_REASON_CODE,
} from '../rights-claims/rights-claim.constants';
import { RightsClearanceResolverService } from '../rights-clearance/rights-clearance-resolver.service';
import {
  GeoAccessCheckResultDto,
  GeoBlockRuleDto,
  GeoBlockRulesResponseDto,
  GeoBlockScope,
  VerifyGeoBlockRulesDto,
} from './dto/geo-block.dto';

/**
 * WP-3.3: there is no `mediaAssetId` here on purpose. `GeoBlockRule` carries no asset reference,
 * so an asset can never narrow or widen a match; a field the matching cannot read would promise
 * asset-level checks that do not exist. See `resolveScope` for the generating side of the same gap.
 */
export interface GeoAccessCheckInput {
  bookId?: string;
  bookVersionId?: string;
  countryCode: string | null;
  scope: GeoBlockScope;
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

/**
 * Phase 12 / WP-1.2: what to do when the upstream proxy did not tell us the country.
 * `allow` keeps the original Phase 12 behaviour and stays the default for backward compatibility;
 * `deny` closes every geo-checked endpoint for requests without a resolved country.
 * Regardless of the setting, a request that a rule of the same scope could match is denied —
 * "we could not tell where you are" must not open a market we know to be closed.
 */
const UNKNOWN_COUNTRY_POLICY_ENV = 'RIGHTS_GEO_UNKNOWN_COUNTRY_POLICY';
const UNKNOWN_COUNTRY_CODE = 'UNKNOWN';

type UnknownCountryPolicy = 'allow' | 'deny';

@Injectable()
export class GeoBlockRuleService {
  private readonly logger = new Logger(GeoBlockRuleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly claimEnforcement: RightsClaimEnforcementService,
    private readonly config: ConfigService,
    private readonly clearanceResolver: RightsClearanceResolverService,
  ) {}

  async generateRulesForVersion(bookVersionId: string): Promise<GeoBlockRulesResponseDto> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: { id: true, bookId: true, rightsProfileId: true },
    });
    if (!version) throw new NotFoundException('BookVersion not found');

    // WP-2.3: `version.rightsProfileId` is the profile the book was created under and is never
    // updated, so regenerating from it reprojected a superseded clearance (R5-03). The rules must
    // describe the markets as the clearance in force sees them.
    const clearance = await this.clearanceResolver.resolveForVersion(bookVersionId);
    const rightsProfileId = clearance.effectiveProfileId;
    if (!rightsProfileId) {
      throw new BadRequestException('Cannot generate geo-block rules without a rights profile');
    }

    const territoryDecisions = await this.prisma.territoryDecision.findMany({
      where: { rightsProfileId },
    });
    const blockedDecisions = territoryDecisions.filter(
      (decision) =>
        decision.finalStatus === 'BLOCKED' ||
        decision.accessPolicy === 'BLOCK' ||
        decision.geoBlockRequired,
    );
    const generatedAt = new Date();

    await this.prisma.$transaction(async (transaction) => {
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
          rightsProfileId,
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
    const rules = await this.prisma.geoBlockRule.findMany({
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
        scopes: Array.from(new Set(activeRules.map((rule) => this.toDtoScope(rule.scope)))).sort(),
      },
    };
  }

  async verifyRulesForVersion(
    bookVersionId: string,
    dto: VerifyGeoBlockRulesDto,
    userId: string,
  ): Promise<GeoBlockRulesResponseDto> {
    const version = await this.getVersionState(bookVersionId);
    const activeRules = await this.prisma.geoBlockRule.findMany({
      where: { bookVersionId, isActive: true },
    });

    if (dto.verified && version.rightsGeoBlockRequired && activeRules.length === 0) {
      throw new BadRequestException('Cannot verify geo-block: no active rules were generated');
    }

    const verifiedAt = dto.verified ? new Date() : null;
    await this.prisma.$transaction(async (transaction) => {
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
    // Phase 16: rights-claim blocks are evaluated first — a worldwide block must fire even when
    // the requesting country is unknown, which the geo-block branch below deliberately allows.
    const claimResult = await this.claimEnforcement.checkClaimAccess({
      bookId: input.bookId,
      bookVersionId: input.bookVersionId,
      countryCode: input.countryCode,
      scope: input.scope,
    });
    if (claimResult.blocked) {
      return {
        allowed: false,
        countryCode: claimResult.countryCode ?? 'UNKNOWN',
        scope: input.scope,
        matchedRuleId: claimResult.matchedBlockId,
        reasonCode: CLAIM_ACCESS_BLOCK_REASON_CODE,
        messageRu: claimResult.messageRu ?? CLAIM_ACCESS_BLOCK_MESSAGE_RU,
        bookVersionId: input.bookVersionId ?? null,
      };
    }

    if (!input.countryCode) {
      return this.resolveUnknownCountryAccess(input);
    }

    const countryCode = input.countryCode.toUpperCase();
    const conditions = await this.buildRuleMatchConditions(input);

    if (conditions.length === 0) return this.allowedResult(input, countryCode);

    const matchedRules = await this.prisma.geoBlockRule.findMany({
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

    // Claim blocks answer with their own code; the body never carries claim or claimant data.
    // `result.messageRu` is the block's internal `reasonRu`, written by an editor and routinely
    // naming the claimant — it stays in the admin `checkAccess` payload and never reaches the
    // public response (Phase 16: claim details are not disclosed outward).
    if (result.reasonCode === CLAIM_ACCESS_BLOCK_REASON_CODE) {
      throw new HttpException(
        {
          statusCode: 451,
          code: CLAIM_ACCESS_BLOCK_REASON_CODE,
          message: CLAIM_ACCESS_BLOCK_MESSAGE,
          messageRu: CLAIM_ACCESS_BLOCK_MESSAGE_RU,
          countryCode: result.countryCode,
          scope: result.scope,
        },
        451,
      );
    }

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
    const rules = await this.prisma.geoBlockRule.findMany({
      where: { bookVersionId, isActive: true },
      orderBy: [{ countryCode: 'asc' }, { scope: 'asc' }],
    });
    return rules.map((rule) => this.mapRule(rule));
  }

  /**
   * Conditions a rule must satisfy to cover this request, country aside: an `ENTIRE_BOOK` rule of
   * the book, a `LANGUAGE_EDITION` rule of the version, or a rule of the requested scope.
   */
  private async buildRuleMatchConditions(
    input: GeoAccessCheckInput,
  ): Promise<Prisma.GeoBlockRuleWhereInput[]> {
    const version = input.bookVersionId
      ? await this.prisma.bookVersion.findUnique({
          where: { id: input.bookVersionId },
          select: { id: true, bookId: true },
        })
      : null;
    if (input.bookVersionId && !version) throw new NotFoundException('BookVersion not found');

    const bookId = input.bookId ?? version?.bookId;
    const conditions: Prisma.GeoBlockRuleWhereInput[] = [];
    if (bookId) conditions.push({ bookId, scope: GeoBlockScope.ENTIRE_BOOK });
    if (input.bookVersionId) {
      conditions.push({
        bookVersionId: input.bookVersionId,
        scope: GeoBlockScope.LANGUAGE_EDITION,
      });
      conditions.push({ bookVersionId: input.bookVersionId, scope: input.scope });
    }
    return conditions;
  }

  /**
   * WP-1.2. The country source is an upstream proxy header we do not control, so "unknown" can mean
   * either "no such header for this request" or "the whole source is gone". Opening a version whose
   * market restrictions are already generated would silently undo Phase 12 in the second case.
   */
  private async resolveUnknownCountryAccess(
    input: GeoAccessCheckInput,
  ): Promise<GeoAccessCheckResultDto> {
    if (this.getUnknownCountryPolicy() === 'deny') {
      this.logger.warn(
        `GeoIP country is unknown for scope ${input.scope}; denying access by ${UNKNOWN_COUNTRY_POLICY_ENV}=deny`,
      );
      return this.unknownCountryBlockedResult(input);
    }

    const conditions = await this.buildRuleMatchConditions(input);
    const coveringRules =
      conditions.length > 0
        ? await this.prisma.geoBlockRule.findMany({
            where: { isActive: true, OR: conditions },
            take: 1,
          })
        : [];

    if (coveringRules.length > 0) {
      this.logger.warn(
        `GeoIP country is unknown for scope ${input.scope}; denying access because the version has active geo-block rules`,
      );
      return this.unknownCountryBlockedResult(input);
    }

    this.logger.warn(
      `GeoIP country is unknown for scope ${input.scope}; allowing access by ${UNKNOWN_COUNTRY_POLICY_ENV}=allow`,
    );
    return this.allowedResult(input, UNKNOWN_COUNTRY_CODE);
  }

  private getUnknownCountryPolicy(): UnknownCountryPolicy {
    const configured = this.config.get<string>(UNKNOWN_COUNTRY_POLICY_ENV)?.trim().toLowerCase();
    return configured === 'deny' ? 'deny' : 'allow';
  }

  private unknownCountryBlockedResult(input: GeoAccessCheckInput): GeoAccessCheckResultDto {
    return {
      allowed: false,
      countryCode: UNKNOWN_COUNTRY_CODE,
      scope: input.scope,
      matchedRuleId: null,
      reasonCode: GEO_BLOCK_REASON_CODE,
      messageRu: GEO_BLOCK_MESSAGE_RU,
      bookVersionId: input.bookVersionId ?? null,
    };
  }

  /**
   * 🔴 `select` ровно на поля `BookVersionGeoBlockState` (`LEGACY-127`).
   * Без него `findUnique` читал всю модель — 66 колонок, из них 29 правовых,
   * включая Json `rightsContentHashInput` в 1,18 МБ (`LEGACY-090`), — а метод
   * зовётся на каждой проверке гейта публикации и каждой генерации гео-правил.
   * Список полей здесь один и тот же с интерфейсом намеренно: лишнее поле в
   * `select` компилятор не заметит, а мегабайт снова поедет из базы.
   */
  private async getVersionState(bookVersionId: string): Promise<BookVersionGeoBlockState> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: {
        id: true,
        bookId: true,
        rightsProfileId: true,
        rightsGeoBlockRequired: true,
        rightsGeoBlockConfigured: true,
        rightsGeoBlockVerifiedAt: true,
        rightsGeoBlockLastGeneratedAt: true,
      },
    });
    if (!version) throw new NotFoundException('BookVersion not found');

    return version;
  }

  /**
   * WP-3.3: `SPECIFIC_ASSET` is not enforceable. `GeoBlockRule` carries no asset reference, the
   * matching conditions never look at `mediaAssetId` and no call-site asks for that scope, so such
   * a rule blocked nothing while the gate counted it as coverage of the country (R5-02). Until an
   * asset-level link exists, the block widens to the edition: over-blocking a market the clearance
   * already closed is the fail-closed side of the choice. The scope the report asked for stays on
   * the `TerritoryDecision` the rule was generated from.
   */
  private resolveScope(value: string | null): GeoBlockScope {
    if (value === GeoBlockScope.SPECIFIC_ASSET) {
      this.logger.warn(
        'Territory decision asks for SPECIFIC_ASSET geo-block; generating a LANGUAGE_EDITION rule instead — asset-level rules cannot be enforced',
      );
      return GeoBlockScope.LANGUAGE_EDITION;
    }
    if (value && Object.values(GeoBlockScope).includes(value as GeoBlockScope)) {
      return value as GeoBlockScope;
    }
    return GeoBlockScope.LANGUAGE_EDITION;
  }

  private scopeRank(scope: GeoBlockRule['scope']): number {
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

  /**
   * ⚠️ Сверять здесь больше нечего, и это осознанно (`LEGACY-204`).
   *
   * Раньше ответное перечисление было рукописной копией схемного, а этот поиск держал их
   * согласие проверяемым компилятором. Копия снята — оба имени указывают на один и тот же
   * `GeoBlockScope` сгенерированного клиента, так что отображение стало тождественным
   * и значение, добавленное в схему, доезжает сюда молча.
   *
   * 🔴 Сторожем расхождения схемы с самой базой этот метод не был никогда: значение,
   * заведённое в Postgres-enum мимо `schema.prisma`, давало здесь `undefined` и роняло
   * ключ `scope` из ответа. Это стережёт `yarn drift-check`, и только он.
   */
  private toDtoScope(scope: GeoBlockRule['scope']): GeoBlockScope {
    return GeoBlockScope[scope];
  }

  private mapRule(rule: GeoBlockRule): GeoBlockRuleDto {
    return {
      id: rule.id,
      bookId: rule.bookId,
      bookVersionId: rule.bookVersionId,
      rightsProfileId: rule.rightsProfileId,
      territoryDecisionId: rule.territoryDecisionId,
      scope: this.toDtoScope(rule.scope),
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
