import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateRightsLicenseDto } from './dto/create-rights-license.dto';
import { LinkRightsLicenseDto } from './dto/link-rights-license.dto';
import { QueryRightsLicensesDto } from './dto/query-rights-licenses.dto';
import { RevokeRightsLicenseDto } from './dto/revoke-rights-license.dto';
import {
  RightsLicenseDetailDto,
  RightsLicenseEventDto,
  RightsLicenseLinkDto,
  RightsLicenseListResponseDto,
  RightsLicenseSummaryDto,
} from './dto/rights-license-response.dto';
import { UpdateRightsLicenseDto } from './dto/update-rights-license.dto';
import { RightsLicenseCoverageService } from './rights-license-coverage.service';
import {
  RightsLicenseDelegate,
  RightsLicenseEventDelegate,
  RightsLicenseEventRecord,
  RightsLicenseEventType,
  RightsLicenseLinkDelegate,
  RightsLicenseLinkRecord,
  RightsLicenseLinkType,
  RightsLicenseMediaFormat,
  RightsLicenseRecord,
  RightsLicenseStatus,
  RightsLicenseTerritoryScope,
  toStringArray,
} from './rights-license-interface';

const SUPPORTED_LANGUAGE_CODES = ['en', 'es', 'fr', 'pt', 'ru'];
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Which FK on RightsLicenseLink each link type is allowed to populate. */
const LINK_TARGET_FIELDS: Record<RightsLicenseLinkType, keyof LinkTargets> = {
  [RightsLicenseLinkType.RIGHTS_PROFILE]: 'rightsProfileId',
  [RightsLicenseLinkType.RIGHTS_COMPONENT]: 'rightsComponentId',
  [RightsLicenseLinkType.COMPONENT_TERRITORY_ASSESSMENT]: 'componentTerritoryAssessmentId',
  [RightsLicenseLinkType.TERRITORY_DECISION]: 'territoryDecisionId',
  [RightsLicenseLinkType.SOURCE_EDITION]: 'sourceEditionId',
  [RightsLicenseLinkType.RIGHTS_EVIDENCE]: 'rightsEvidenceId',
  [RightsLicenseLinkType.BOOK_VERSION]: 'bookVersionId',
};

interface LinkTargets {
  rightsProfileId?: string;
  rightsComponentId?: string;
  componentTerritoryAssessmentId?: string;
  territoryDecisionId?: string;
  sourceEditionId?: string;
  rightsEvidenceId?: string;
  bookVersionId?: string;
}

interface MediaAssetRow {
  id: string;
  isDeleted: boolean;
}

@Injectable()
export class RightsLicensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coverageService: RightsLicenseCoverageService,
  ) {}

  private get licenseDelegate(): RightsLicenseDelegate {
    return (this.prisma as unknown as Record<string, unknown>)[
      'rightsLicense'
    ] as RightsLicenseDelegate;
  }

  private get linkDelegate(): RightsLicenseLinkDelegate {
    return (this.prisma as unknown as Record<string, unknown>)[
      'rightsLicenseLink'
    ] as RightsLicenseLinkDelegate;
  }

  private get eventDelegate(): RightsLicenseEventDelegate {
    return (this.prisma as unknown as Record<string, unknown>)[
      'rightsLicenseEvent'
    ] as RightsLicenseEventDelegate;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async findAll(query: QueryRightsLicensesDto): Promise<RightsLicenseListResponseDto> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 100) : 20;

    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (query.licenseType) where.licenseType = query.licenseType;
    if (query.territoryScope) where.territoryScope = query.territoryScope;
    if (query.q) {
      const contains = { contains: query.q, mode: 'insensitive' };
      where.OR = [
        { title: contains },
        { licensor: contains },
        { licensee: contains },
        { rightsHolder: contains },
        { referenceNumber: contains },
        { licenseKey: contains },
      ];
    }
    if (query.expiringInDays) {
      where.expiresAt = {
        gte: new Date(),
        lte: new Date(Date.now() + query.expiringInDays * MS_PER_DAY),
      };
    }

    const licenses = await this.licenseDelegate.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    const filtered = await this.applyInMemoryFilters(licenses, query);
    const start = (page - 1) * limit;

    return {
      items: filtered.slice(start, start + limit).map((license) => this.mapSummary(license)),
      total: filtered.length,
      page,
      limit,
    };
  }

  /**
   * JSON scope columns and link relations cannot be filtered in SQL with the dynamic
   * delegates, so these predicates are applied after the query and before paging.
   */
  private async applyInMemoryFilters(
    licenses: RightsLicenseRecord[],
    query: QueryRightsLicensesDto,
  ): Promise<RightsLicenseRecord[]> {
    let result = licenses;

    if (query.countryCode) {
      const code = query.countryCode;
      result = result.filter((license) => this.coverageService.coversCountry(license, code));
    }
    if (query.languageCode) {
      const language = query.languageCode;
      result = result.filter((license) => this.coverageService.coversLanguage(license, language));
    }
    if (query.mediaFormat) {
      const format = query.mediaFormat;
      result = result.filter((license) =>
        this.coverageService.coversMediaFormats(license, [format]),
      );
    }
    if (query.rightsProfileId) {
      const allowed = new Set(
        (await this.coverageService.loadLicensesForProfile(query.rightsProfileId)).map(
          (license) => license.id,
        ),
      );
      result = result.filter((license) => allowed.has(license.id));
    }
    if (query.bookVersionId) {
      const allowed = new Set(
        (await this.coverageService.loadLicensesForVersion(query.bookVersionId)).map(
          (license) => license.id,
        ),
      );
      result = result.filter((license) => allowed.has(license.id));
    }

    return result;
  }

  async findOne(id: string): Promise<RightsLicenseDetailDto> {
    const license = await this.licenseDelegate.findUnique({ where: { id } });
    if (!license) throw new NotFoundException('RightsLicense not found');
    return this.buildDetail(license);
  }

  async listForProfile(rightsProfileId: string): Promise<RightsLicenseListResponseDto> {
    const licenses = await this.coverageService.loadLicensesForProfile(rightsProfileId);
    return this.asListResponse(licenses);
  }

  async listForVersion(bookVersionId: string): Promise<RightsLicenseListResponseDto> {
    const licenses = await this.coverageService.loadLicensesForVersion(bookVersionId);
    return this.asListResponse(licenses);
  }

  private asListResponse(licenses: RightsLicenseRecord[]): RightsLicenseListResponseDto {
    const items = licenses.map((license) => this.mapSummary(license));
    return { items, total: items.length, page: 1, limit: items.length };
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  async create(dto: CreateRightsLicenseDto, userId: string): Promise<RightsLicenseDetailDto> {
    await this.validatePayload(dto, null);

    const license = await this.licenseDelegate.create({
      data: { ...this.buildWriteData(dto), createdByUserId: userId },
    });

    await this.recordEvent(license.id, RightsLicenseEventType.CREATED, {
      currentStatus: license.status,
      userId,
    });
    if (license.status === RightsLicenseStatus.ACTIVE) {
      await this.recordEvent(license.id, RightsLicenseEventType.ACTIVATED, {
        currentStatus: license.status,
        userId,
      });
    }

    return this.buildDetail(license);
  }

  async update(
    id: string,
    dto: UpdateRightsLicenseDto,
    userId: string,
  ): Promise<RightsLicenseDetailDto> {
    const existing = await this.licenseDelegate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('RightsLicense not found');

    if (existing.status === RightsLicenseStatus.REVOKED || existing.revokedAt) {
      const touchesMoreThanNotes = Object.keys(dto).some((key) => key !== 'notesRu');
      if (touchesMoreThanNotes) {
        throw new BadRequestException('LICENSE_REVOKED_IMMUTABLE');
      }
    }

    await this.validatePayload(dto, existing);

    const updated = await this.licenseDelegate.update({
      where: { id },
      data: this.buildWriteData(dto),
    });

    await this.recordEvent(id, RightsLicenseEventType.UPDATED, {
      previousStatus: existing.status,
      currentStatus: updated.status,
      userId,
    });
    if (
      updated.status === RightsLicenseStatus.ACTIVE &&
      existing.status !== RightsLicenseStatus.ACTIVE
    ) {
      await this.recordEvent(id, RightsLicenseEventType.ACTIVATED, {
        previousStatus: existing.status,
        currentStatus: updated.status,
        userId,
      });
    }

    return this.buildDetail(updated);
  }

  async revoke(
    id: string,
    dto: RevokeRightsLicenseDto,
    userId: string,
  ): Promise<RightsLicenseDetailDto> {
    const existing = await this.licenseDelegate.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('RightsLicense not found');
    if (!dto.reasonRu || dto.reasonRu.trim().length === 0) {
      throw new BadRequestException('REVOCATION_REASON_REQUIRED');
    }

    const warnings: string[] = [];
    if (!existing.revocable) {
      warnings.push(
        'Лицензия помечена как безотзывная (revocable = false) — отзыв выполнен, но требует юридической проверки.',
      );
    }

    const updated = await this.licenseDelegate.update({
      where: { id },
      data: {
        status: RightsLicenseStatus.REVOKED,
        revokedAt: new Date(),
        revokedByUserId: userId,
        revocationReasonRu: dto.reasonRu,
      },
    });

    await this.recordEvent(id, RightsLicenseEventType.REVOKED, {
      previousStatus: existing.status,
      currentStatus: RightsLicenseStatus.REVOKED,
      notesRu: dto.reasonRu,
      userId,
      payload: existing.revocable ? undefined : { wasIrrevocable: true },
    });

    return this.buildDetail(updated, warnings);
  }

  async link(
    licenseId: string,
    dto: LinkRightsLicenseDto,
    userId: string,
  ): Promise<RightsLicenseLinkDto> {
    const license = await this.licenseDelegate.findUnique({ where: { id: licenseId } });
    if (!license) throw new NotFoundException('RightsLicense not found');

    const targetField = LINK_TARGET_FIELDS[dto.linkType];
    const targets = this.collectLinkTargets(dto);
    const providedFields = Object.keys(targets);

    if (providedFields.length !== 1 || providedFields[0] !== targetField) {
      throw new BadRequestException('LINK_TARGET_MISMATCH');
    }

    const targetId = targets[targetField];
    if (!targetId) throw new BadRequestException('LINK_TARGET_MISMATCH');

    await this.assertLinkTargetExists(dto.linkType, targetId);

    const existing = await this.linkDelegate.findFirst({
      where: { rightsLicenseId: licenseId, [targetField]: targetId },
    });
    if (existing) return this.mapLink(existing);

    const created = await this.linkDelegate.create({
      data: {
        rightsLicenseId: licenseId,
        linkType: dto.linkType,
        [targetField]: targetId,
        coversCountryCodes: dto.coversCountryCodes
          ? dto.coversCountryCodes.map((code) => code.toUpperCase())
          : undefined,
        notesRu: dto.notesRu,
        createdByUserId: userId,
      },
    });

    await this.recordEvent(licenseId, RightsLicenseEventType.LINKED, {
      currentStatus: license.status,
      userId,
      payload: { linkType: dto.linkType, targetId },
    });

    return this.mapLink(created);
  }

  async unlink(licenseId: string, linkId: string, userId: string): Promise<{ success: true }> {
    const license = await this.licenseDelegate.findUnique({ where: { id: licenseId } });
    if (!license) throw new NotFoundException('RightsLicense not found');

    const link = await this.linkDelegate.findFirst({
      where: { id: linkId, rightsLicenseId: licenseId },
    });
    if (!link) throw new NotFoundException('RightsLicenseLink not found');

    await this.linkDelegate.delete({ where: { id: linkId } });
    await this.recordEvent(licenseId, RightsLicenseEventType.UNLINKED, {
      currentStatus: license.status,
      userId,
      payload: { linkType: link.linkType, linkId },
    });

    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  private async validatePayload(
    dto: CreateRightsLicenseDto | UpdateRightsLicenseDto,
    existing: RightsLicenseRecord | null,
  ): Promise<void> {
    const title = dto.title ?? existing?.title;
    const licensor = dto.licensor ?? existing?.licensor;
    if (!title || title.trim().length === 0) throw new BadRequestException('TITLE_REQUIRED');
    if (!licensor || licensor.trim().length === 0)
      throw new BadRequestException('LICENSOR_REQUIRED');

    const territoryScope =
      dto.territoryScope ?? existing?.territoryScope ?? RightsLicenseTerritoryScope.UNKNOWN;
    const countryCodes = dto.countryCodes ?? toStringArray(existing?.countryCodes);
    const excludedCountryCodes =
      dto.excludedCountryCodes ?? toStringArray(existing?.excludedCountryCodes);

    if (territoryScope === RightsLicenseTerritoryScope.COUNTRY_LIST) {
      this.assertCountryCodes(countryCodes, 'COUNTRY_CODES_REQUIRED');
    }
    if (territoryScope === RightsLicenseTerritoryScope.EXCEPT_COUNTRY_LIST) {
      this.assertCountryCodes(excludedCountryCodes, 'EXCLUDED_COUNTRY_CODES_REQUIRED');
    }

    const languageCodes = dto.languageCodes ?? toStringArray(existing?.languageCodes);
    for (const code of languageCodes) {
      if (!SUPPORTED_LANGUAGE_CODES.includes(code.toLowerCase())) {
        throw new BadRequestException('INVALID_LANGUAGE_CODE');
      }
    }

    const mediaFormats = dto.mediaFormats ?? toStringArray(existing?.mediaFormats);
    const allowedFormats = Object.values(RightsLicenseMediaFormat) as string[];
    for (const format of mediaFormats) {
      if (!allowedFormats.includes(format)) throw new BadRequestException('INVALID_MEDIA_FORMAT');
    }

    const effectiveFrom = this.resolveDate(dto.effectiveFrom, existing?.effectiveFrom);
    const expiresAt = this.resolveDate(dto.expiresAt, existing?.expiresAt);
    const isPerpetual = dto.isPerpetual ?? existing?.isPerpetual ?? false;

    if (effectiveFrom && expiresAt && expiresAt.getTime() <= effectiveFrom.getTime()) {
      throw new BadRequestException('INVALID_LICENSE_PERIOD');
    }
    if (isPerpetual && expiresAt) {
      throw new BadRequestException('PERPETUAL_WITH_EXPIRY');
    }

    const attributionRequired = dto.attributionRequired ?? existing?.attributionRequired ?? false;
    const requiredAttributionText =
      dto.requiredAttributionText ?? existing?.requiredAttributionText ?? null;
    if (attributionRequired && !requiredAttributionText) {
      throw new BadRequestException('ATTRIBUTION_TEXT_REQUIRED');
    }

    const status = dto.status ?? existing?.status ?? RightsLicenseStatus.DRAFT;
    if (status === RightsLicenseStatus.ACTIVE && expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('CANNOT_ACTIVATE_EXPIRED_LICENSE');
    }

    if (dto.documentSha256 && !SHA256_PATTERN.test(dto.documentSha256)) {
      throw new BadRequestException('INVALID_DOCUMENT_SHA256');
    }

    if (dto.documentMediaAssetId) {
      const asset = (await this.prisma.mediaAsset.findUnique({
        where: { id: dto.documentMediaAssetId },
        select: { id: true, isDeleted: true },
      })) as MediaAssetRow | null;
      if (!asset || asset.isDeleted) throw new BadRequestException('MEDIA_ASSET_NOT_FOUND');
    }
  }

  private assertCountryCodes(codes: string[], errorCode: string): void {
    if (!Array.isArray(codes) || codes.length === 0) throw new BadRequestException(errorCode);
    for (const code of codes) {
      if (!COUNTRY_CODE_PATTERN.test(code.toUpperCase())) {
        throw new BadRequestException('INVALID_COUNTRY_CODE');
      }
    }
  }

  private async assertLinkTargetExists(
    linkType: RightsLicenseLinkType,
    targetId: string,
  ): Promise<void> {
    const exists = await this.findLinkTarget(linkType, targetId);
    if (!exists) throw new NotFoundException('LINK_TARGET_NOT_FOUND');
  }

  private async findLinkTarget(
    linkType: RightsLicenseLinkType,
    id: string,
  ): Promise<{ id: string } | null> {
    const select = { id: true };
    switch (linkType) {
      case RightsLicenseLinkType.RIGHTS_PROFILE:
        return this.prisma.rightsProfile.findUnique({ where: { id }, select });
      case RightsLicenseLinkType.RIGHTS_COMPONENT:
        return this.prisma.rightsComponent.findUnique({ where: { id }, select });
      case RightsLicenseLinkType.COMPONENT_TERRITORY_ASSESSMENT:
        return this.prisma.componentTerritoryAssessment.findUnique({ where: { id }, select });
      case RightsLicenseLinkType.TERRITORY_DECISION:
        return this.prisma.territoryDecision.findUnique({ where: { id }, select });
      case RightsLicenseLinkType.SOURCE_EDITION:
        return this.prisma.sourceEdition.findUnique({ where: { id }, select });
      case RightsLicenseLinkType.RIGHTS_EVIDENCE:
        return this.prisma.rightsEvidence.findUnique({ where: { id }, select });
      case RightsLicenseLinkType.BOOK_VERSION:
        return this.prisma.bookVersion.findUnique({ where: { id }, select });
      default:
        return null;
    }
  }

  private collectLinkTargets(dto: LinkRightsLicenseDto): LinkTargets {
    const targets: LinkTargets = {};
    if (dto.rightsProfileId) targets.rightsProfileId = dto.rightsProfileId;
    if (dto.rightsComponentId) targets.rightsComponentId = dto.rightsComponentId;
    if (dto.componentTerritoryAssessmentId) {
      targets.componentTerritoryAssessmentId = dto.componentTerritoryAssessmentId;
    }
    if (dto.territoryDecisionId) targets.territoryDecisionId = dto.territoryDecisionId;
    if (dto.sourceEditionId) targets.sourceEditionId = dto.sourceEditionId;
    if (dto.rightsEvidenceId) targets.rightsEvidenceId = dto.rightsEvidenceId;
    if (dto.bookVersionId) targets.bookVersionId = dto.bookVersionId;
    return targets;
  }

  // ---------------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------------

  private buildWriteData(
    dto: CreateRightsLicenseDto | UpdateRightsLicenseDto,
  ): Record<string, unknown> {
    const data: Record<string, unknown> = {};

    const assign = (key: string, value: unknown): void => {
      if (value !== undefined) data[key] = value;
    };

    assign('licenseKey', dto.licenseKey);
    assign('licenseType', dto.licenseType);
    assign('status', dto.status);
    assign('title', dto.title);
    assign('licensor', dto.licensor);
    assign('licensee', dto.licensee);
    assign('rightsHolder', dto.rightsHolder);
    assign('referenceNumber', dto.referenceNumber);
    assign('grantedAt', dto.grantedAt ? new Date(dto.grantedAt) : undefined);
    assign('effectiveFrom', dto.effectiveFrom ? new Date(dto.effectiveFrom) : undefined);
    assign('expiresAt', dto.expiresAt ? new Date(dto.expiresAt) : undefined);
    assign('isPerpetual', dto.isPerpetual);
    assign('territoryScope', dto.territoryScope);
    assign(
      'countryCodes',
      dto.countryCodes ? dto.countryCodes.map((code) => code.toUpperCase()) : undefined,
    );
    assign(
      'excludedCountryCodes',
      dto.excludedCountryCodes
        ? dto.excludedCountryCodes.map((code) => code.toUpperCase())
        : undefined,
    );
    assign(
      'languageCodes',
      dto.languageCodes ? dto.languageCodes.map((code) => code.toLowerCase()) : undefined,
    );
    assign('mediaFormats', dto.mediaFormats);
    assign('commercialUseAllowed', dto.commercialUseAllowed);
    assign('modificationAllowed', dto.modificationAllowed);
    assign('translationAllowed', dto.translationAllowed);
    assign('sublicensingAllowed', dto.sublicensingAllowed);
    assign('attributionRequired', dto.attributionRequired);
    assign('requiredAttributionText', dto.requiredAttributionText);
    assign('exclusive', dto.exclusive);
    assign('revocable', dto.revocable);
    assign('royaltyTermsRu', dto.royaltyTermsRu);
    assign('otherConditionsRu', dto.otherConditionsRu);
    assign('notesRu', dto.notesRu);
    assign('documentStorageKey', dto.documentStorageKey);
    assign('documentSha256', dto.documentSha256);
    assign('documentUrl', dto.documentUrl);
    assign('documentMediaAssetId', dto.documentMediaAssetId);
    assign('sourceEvidenceIds', dto.sourceEvidenceIds);
    assign('confidence', dto.confidence);

    return data;
  }

  private async recordEvent(
    rightsLicenseId: string,
    eventType: RightsLicenseEventType,
    options: {
      previousStatus?: RightsLicenseStatus;
      currentStatus?: RightsLicenseStatus;
      notesRu?: string;
      userId?: string;
      payload?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.eventDelegate.create({
      data: {
        rightsLicenseId,
        eventType,
        previousStatus: options.previousStatus,
        currentStatus: options.currentStatus,
        notesRu: options.notesRu,
        payload: options.payload,
        createdByUserId: options.userId,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Mapping
  // ---------------------------------------------------------------------------

  mapSummary(license: RightsLicenseRecord, at: Date = new Date()): RightsLicenseSummaryDto {
    return {
      id: license.id,
      licenseKey: license.licenseKey,
      licenseType: license.licenseType,
      status: license.status,
      effectiveStatus: this.coverageService.effectiveStatus(license, at),
      title: license.title,
      licensor: license.licensor,
      licensee: license.licensee,
      rightsHolder: license.rightsHolder,
      referenceNumber: license.referenceNumber,
      grantedAt: license.grantedAt ? license.grantedAt.toISOString() : null,
      effectiveFrom: license.effectiveFrom ? license.effectiveFrom.toISOString() : null,
      expiresAt: license.expiresAt ? license.expiresAt.toISOString() : null,
      isPerpetual: license.isPerpetual,
      territoryScope: license.territoryScope,
      countryCodes: toStringArray(license.countryCodes),
      excludedCountryCodes: toStringArray(license.excludedCountryCodes),
      languageCodes: toStringArray(license.languageCodes),
      mediaFormats: toStringArray(license.mediaFormats) as RightsLicenseMediaFormat[],
      commercialUseAllowed: license.commercialUseAllowed,
      modificationAllowed: license.modificationAllowed,
      translationAllowed: license.translationAllowed,
      sublicensingAllowed: license.sublicensingAllowed,
      attributionRequired: license.attributionRequired,
      requiredAttributionText: license.requiredAttributionText,
      exclusive: license.exclusive,
      revocable: license.revocable,
      revokedAt: license.revokedAt ? license.revokedAt.toISOString() : null,
      revocationReasonRu: license.revocationReasonRu,
      confidence: license.confidence,
      createdAt: license.createdAt.toISOString(),
      updatedAt: license.updatedAt.toISOString(),
    };
  }

  private async buildDetail(
    license: RightsLicenseRecord,
    warnings: string[] = [],
  ): Promise<RightsLicenseDetailDto> {
    const links = await this.linkDelegate.findMany({
      where: { rightsLicenseId: license.id },
      orderBy: { createdAt: 'asc' },
    });
    const events = await this.eventDelegate.findMany({
      where: { rightsLicenseId: license.id },
      orderBy: { createdAt: 'desc' },
    });

    return {
      ...this.mapSummary(license),
      royaltyTermsRu: license.royaltyTermsRu,
      otherConditionsRu: license.otherConditionsRu,
      notesRu: license.notesRu,
      documentStorageKey: license.documentStorageKey,
      documentSha256: license.documentSha256,
      documentUrl: license.documentUrl,
      documentMediaAssetId: license.documentMediaAssetId,
      sourceEvidenceIds: toStringArray(license.sourceEvidenceIds),
      createdByUserId: license.createdByUserId,
      revokedByUserId: license.revokedByUserId,
      links: links.map((link) => this.mapLink(link)),
      events: events.map((event) => this.mapEvent(event)),
      warnings,
    };
  }

  private mapLink(link: RightsLicenseLinkRecord): RightsLicenseLinkDto {
    return {
      id: link.id,
      rightsLicenseId: link.rightsLicenseId,
      linkType: link.linkType,
      rightsProfileId: link.rightsProfileId,
      rightsComponentId: link.rightsComponentId,
      componentTerritoryAssessmentId: link.componentTerritoryAssessmentId,
      territoryDecisionId: link.territoryDecisionId,
      sourceEditionId: link.sourceEditionId,
      rightsEvidenceId: link.rightsEvidenceId,
      bookVersionId: link.bookVersionId,
      coversCountryCodes: toStringArray(link.coversCountryCodes),
      notesRu: link.notesRu,
      createdAt: link.createdAt.toISOString(),
    };
  }

  private mapEvent(event: RightsLicenseEventRecord): RightsLicenseEventDto {
    return {
      id: event.id,
      eventType: event.eventType,
      previousStatus: event.previousStatus,
      currentStatus: event.currentStatus,
      notesRu: event.notesRu,
      createdByUserId: event.createdByUserId,
      createdAt: event.createdAt.toISOString(),
    };
  }

  private resolveDate(value: string | undefined, fallback: Date | null | undefined): Date | null {
    if (value !== undefined) return new Date(value);
    return fallback ?? null;
  }
}
