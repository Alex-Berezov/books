import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsNotificationsService } from '../rights-agent/rights-notifications.service';
import {
  RightsNotificationSeverity,
  RightsNotificationType,
} from '../rights-agent/rights-agent-interface';
import {
  LEGAL_CHANGE_TARGET_PROFILE_STATUSES,
  RECHECK_EMBEDDED_TASKS_LIMIT,
  RECHECK_ERROR_CODES,
  RECHECK_LIST_DEFAULT_LIMIT,
  RECHECK_LIST_MAX_LIMIT,
} from './rights-recheck.constants';
import { recheckError } from './rights-recheck.errors';
import { RightsRecheckService } from './rights-recheck.service';
import {
  RightsLegalChangeStatus,
  RightsRecheckReason,
  RightsRecheckSeverity,
  RightsRecheckTriggerSource,
  toCountryCodeArray,
} from './rights-recheck-interface';
import { addDays } from './rights-recheck.util';
import type { CreateLegalChangeDto } from './dto/create-legal-change.dto';
import type {
  LegalChangeDetailDto,
  LegalChangeDto,
  LegalChangeListResponseDto,
} from './dto/legal-change-response.dto';
import type { ListLegalChangesDto } from './dto/list-legal-changes.dto';
import type { UpdateLegalChangeDto } from './dto/update-legal-change.dto';
import type {
  RecheckDatabaseClient,
  RightsLegalChangeEventRecord,
} from './rights-recheck-interface';

const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

/** Notification severity of the "legal change applied" broadcast. */
const NOTIFICATION_SEVERITY_BY_EVENT: Record<RightsRecheckSeverity, RightsNotificationSeverity> = {
  INFO: RightsNotificationSeverity.INFO,
  WARNING: RightsNotificationSeverity.WARNING,
  BLOCKING: RightsNotificationSeverity.ERROR,
};

/**
 * A legal change is declared by a human — Phase 18 has no external parsers or feeds.
 * Applying it opens a recheck task for every rights profile that decided on an affected country.
 */
@Injectable()
export class RightsLegalChangeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recheckService: RightsRecheckService,
    private readonly notifications: RightsNotificationsService,
  ) {}

  private getDatabase(): RecheckDatabaseClient {
    return this.prisma as unknown as RecheckDatabaseClient;
  }

  async create(dto: CreateLegalChangeDto, userId: string): Promise<LegalChangeDto> {
    const jurisdictionCodes = this.validateJurisdictions(
      dto.jurisdictionCodes,
      dto.appliesToAllCountries,
    );

    const created = await this.getDatabase().rightsLegalChangeEvent.create({
      data: {
        titleRu: dto.titleRu,
        descriptionRu: dto.descriptionRu,
        changeType: dto.changeType,
        status: RightsLegalChangeStatus.DRAFT,
        severity: dto.severity ?? RightsRecheckSeverity.WARNING,
        jurisdictionCodes,
        appliesToAllCountries: dto.appliesToAllCountries ?? false,
        effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : null,
        sourceUrl: dto.sourceUrl ?? null,
        sourceTitle: dto.sourceTitle ?? null,
        createdByUserId: userId,
      },
    });

    return this.toDto(created);
  }

  async update(id: string, dto: UpdateLegalChangeDto, userId: string): Promise<LegalChangeDto> {
    const existing = await this.loadEvent(id);
    if (existing.status !== RightsLegalChangeStatus.DRAFT) {
      throw recheckError(HttpStatus.CONFLICT, RECHECK_ERROR_CODES.LEGAL_CHANGE_NOT_EDITABLE, {
        status: existing.status,
      });
    }

    const data: Record<string, unknown> = {};
    if (dto.titleRu !== undefined) data.titleRu = dto.titleRu;
    if (dto.descriptionRu !== undefined) data.descriptionRu = dto.descriptionRu;
    if (dto.changeType !== undefined) data.changeType = dto.changeType;
    if (dto.severity !== undefined) data.severity = dto.severity;
    if (dto.appliesToAllCountries !== undefined) {
      data.appliesToAllCountries = dto.appliesToAllCountries;
    }
    if (dto.jurisdictionCodes !== undefined) {
      data.jurisdictionCodes = this.validateJurisdictions(
        dto.jurisdictionCodes,
        dto.appliesToAllCountries ?? existing.appliesToAllCountries,
      );
    }
    if (dto.effectiveFrom !== undefined) {
      data.effectiveFrom = dto.effectiveFrom ? new Date(dto.effectiveFrom) : null;
    }
    if (dto.sourceUrl !== undefined) data.sourceUrl = dto.sourceUrl ?? null;
    if (dto.sourceTitle !== undefined) data.sourceTitle = dto.sourceTitle ?? null;

    void userId;
    const updated = await this.getDatabase().rightsLegalChangeEvent.update({
      where: { id },
      data,
    });
    return this.toDto(updated);
  }

  async list(query: ListLegalChangesDto): Promise<LegalChangeListResponseDto> {
    const database = this.getDatabase();
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit =
      query.limit && query.limit > 0
        ? Math.min(query.limit, RECHECK_LIST_MAX_LIMIT)
        : RECHECK_LIST_DEFAULT_LIMIT;

    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (query.changeType) where.changeType = query.changeType;
    if (query.severity) where.severity = query.severity;

    const [total, items] = await Promise.all([
      database.rightsLegalChangeEvent.count({ where }),
      database.rightsLegalChangeEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    // `jurisdictionCodes` is JSONB: filtering happens in memory on the fetched page rather
    // than through a JSON path query, which would not use any index anyway.
    const filtered = query.countryCode
      ? items.filter(
          (item) =>
            item.appliesToAllCountries ||
            toCountryCodeArray(item.jurisdictionCodes).includes(query.countryCode as string),
        )
      : items;

    return { items: filtered.map((item) => this.toDto(item)), total, page, limit };
  }

  async getById(id: string): Promise<LegalChangeDetailDto> {
    const database = this.getDatabase();
    const event = await this.loadEvent(id);

    const now = new Date();
    const config = this.recheckService.getRuntimeConfig();

    const [tasksCount, tasks] = await Promise.all([
      database.rightsRecheckTask.count({ where: { legalChangeEventId: id } }),
      database.rightsRecheckTask.findMany({
        where: { legalChangeEventId: id },
        orderBy: [{ severity: 'desc' }, { dueAt: 'asc' }],
        take: RECHECK_EMBEDDED_TASKS_LIMIT,
      }),
    ]);

    return {
      ...this.toDto(event),
      tasks: tasks.map((task) => this.recheckService.toTaskDto(task, now, config)),
      tasksCount,
    };
  }

  /**
   * Opens recheck tasks for every affected rights profile. Runs in batches and sends exactly
   * one summary notification — one per profile would flood the bell.
   */
  async apply(id: string, userId: string): Promise<LegalChangeDetailDto> {
    const database = this.getDatabase();
    const event = await this.loadEvent(id);

    if (event.status !== RightsLegalChangeStatus.DRAFT) {
      throw recheckError(HttpStatus.CONFLICT, RECHECK_ERROR_CODES.LEGAL_CHANGE_ALREADY_APPLIED, {
        status: event.status,
      });
    }

    const now = new Date();
    const config = this.recheckService.getRuntimeConfig();
    const codes = toCountryCodeArray(event.jurisdictionCodes);

    const dueAt =
      event.effectiveFrom && event.effectiveFrom.getTime() > now.getTime()
        ? new Date(event.effectiveFrom)
        : addDays(now, config.legalChangeDueDays);

    const profileIds = await this.resolveAffectedProfileIds(
      database,
      event.appliesToAllCountries,
      codes,
      config.batchSize,
    );

    let createdTasksCount = 0;
    for (const profileId of profileIds) {
      const profile = await database.rightsProfile.findUnique({ where: { id: profileId } });
      if (!profile) continue;

      const baseline = await this.recheckService.findApprovedReview(database, profileId);

      const { created } = await this.recheckService.ensureTask({
        reason: RightsRecheckReason.LEGAL_CHANGE,
        source: RightsRecheckTriggerSource.LEGAL_CHANGE,
        severity: event.severity,
        rightsProfileId: profileId,
        rightsIntakeId: profile.rightsIntakeId,
        legalChangeEventId: event.id,
        baselineReviewId: baseline?.id ?? null,
        dueAt,
        affectedCountryCodes: event.appliesToAllCountries ? [] : codes,
        titleRu: `Изменение законодательства: ${event.titleRu}`,
        descriptionRu: event.descriptionRu,
        // One summary broadcast instead of N per-profile notifications.
        suppressNotification: true,
      });

      if (created) createdTasksCount += 1;
    }

    await database.rightsLegalChangeEvent.update({
      where: { id },
      data: {
        status: RightsLegalChangeStatus.APPLIED,
        appliedAt: now,
        appliedByUserId: userId,
        affectedProfilesCount: profileIds.length,
        createdTasksCount,
      },
    });

    await this.notifications.create({
      type: RightsNotificationType.LEGAL_CHANGE_APPLIED,
      severity:
        NOTIFICATION_SEVERITY_BY_EVENT[event.severity] ?? RightsNotificationSeverity.WARNING,
      titleRu: 'Применено изменение законодательства',
      messageRu: `«${event.titleRu}»: открыто задач перепроверки — ${createdTasksCount}, затронуто профилей прав — ${profileIds.length}.`,
      targetUserId: null,
      payload: {
        legalChangeEventId: event.id,
        createdTasksCount,
        affectedProfilesCount: profileIds.length,
      },
    });

    return this.getById(id);
  }

  /** Archiving does not close the tasks it opened — they are independent work items by then. */
  async archive(id: string, userId: string): Promise<LegalChangeDto> {
    await this.loadEvent(id);
    void userId;

    const updated = await this.getDatabase().rightsLegalChangeEvent.update({
      where: { id },
      data: { status: RightsLegalChangeStatus.ARCHIVED, archivedAt: new Date() },
    });
    return this.toDto(updated);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async resolveAffectedProfileIds(
    database: RecheckDatabaseClient,
    appliesToAllCountries: boolean,
    codes: string[],
    batchSize: number,
  ): Promise<string[]> {
    const candidates: string[] = [];
    let skip = 0;

    // Batched so a catalogue of any size stays within memory.
    for (;;) {
      const page = await database.rightsProfile.findMany({
        where: { isCurrent: true, status: { in: [...LEGAL_CHANGE_TARGET_PROFILE_STATUSES] } },
        orderBy: { createdAt: 'asc' },
        skip,
        take: batchSize,
      });
      candidates.push(...page.map((profile) => profile.id));
      if (page.length < batchSize) break;
      skip += batchSize;
    }

    if (appliesToAllCountries) {
      return candidates;
    }

    if (codes.length === 0) {
      return [];
    }

    const decisions = await database.territoryDecision.findMany({
      where: { countryCode: { in: codes } },
      select: { rightsProfileId: true, countryCode: true, finalStatus: true },
      distinct: ['rightsProfileId'],
    });
    const decided = new Set(decisions.map((decision) => decision.rightsProfileId));

    return candidates.filter((profileId) => decided.has(profileId));
  }

  private validateJurisdictions(
    codes: string[] | undefined,
    appliesToAllCountries: boolean | undefined,
  ): string[] {
    const normalized = codes ?? [];

    if (appliesToAllCountries) {
      // Codes are ignored in this mode but still must not be malformed.
      if (normalized.some((code) => !COUNTRY_CODE_PATTERN.test(code))) {
        throw recheckError(
          HttpStatus.BAD_REQUEST,
          RECHECK_ERROR_CODES.LEGAL_CHANGE_INVALID_JURISDICTION,
        );
      }
      return normalized;
    }

    if (normalized.length === 0 || normalized.some((code) => !COUNTRY_CODE_PATTERN.test(code))) {
      throw recheckError(
        HttpStatus.BAD_REQUEST,
        RECHECK_ERROR_CODES.LEGAL_CHANGE_INVALID_JURISDICTION,
      );
    }

    return Array.from(new Set(normalized));
  }

  private async loadEvent(id: string): Promise<RightsLegalChangeEventRecord> {
    const event = await this.getDatabase().rightsLegalChangeEvent.findUnique({ where: { id } });
    if (!event) {
      throw recheckError(HttpStatus.NOT_FOUND, RECHECK_ERROR_CODES.LEGAL_CHANGE_NOT_FOUND);
    }
    return event;
  }

  private toDto(event: RightsLegalChangeEventRecord): LegalChangeDto {
    return {
      id: event.id,
      titleRu: event.titleRu,
      descriptionRu: event.descriptionRu,
      changeType: event.changeType,
      status: event.status,
      severity: event.severity,
      jurisdictionCodes: toCountryCodeArray(event.jurisdictionCodes),
      appliesToAllCountries: event.appliesToAllCountries,
      effectiveFrom: event.effectiveFrom ? new Date(event.effectiveFrom).toISOString() : null,
      sourceUrl: event.sourceUrl,
      sourceTitle: event.sourceTitle,
      appliedAt: event.appliedAt ? new Date(event.appliedAt).toISOString() : null,
      appliedByUserId: event.appliedByUserId,
      affectedProfilesCount: event.affectedProfilesCount,
      createdTasksCount: event.createdTasksCount,
      archivedAt: event.archivedAt ? new Date(event.archivedAt).toISOString() : null,
      createdByUserId: event.createdByUserId,
      createdAt: new Date(event.createdAt).toISOString(),
      updatedAt: new Date(event.updatedAt).toISOString(),
    };
  }
}
