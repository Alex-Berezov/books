import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ApplyClaimBlockDto } from './dto/apply-claim-block.dto';
import { AssignRightsClaimDto } from './dto/assign-rights-claim.dto';
import { ChangeRightsClaimStatusDto } from './dto/change-rights-claim-status.dto';
import { CreateClaimAttachmentDto } from './dto/create-claim-attachment.dto';
import { CreateRightsClaimDto } from './dto/create-rights-claim.dto';
import { LiftClaimBlockDto } from './dto/lift-claim-block.dto';
import { LinkClaimComponentDto } from './dto/link-claim-component.dto';
import { QueryRightsClaimsDto } from './dto/query-rights-claims.dto';
import { RecordClaimResponseDto } from './dto/record-claim-response.dto';
import { RecordCounterNoticeDto } from './dto/record-counter-notice.dto';
import {
  ClaimGateEvaluationDto,
  ClaimIssueDto,
  ClaimMutationResultDto,
  RightsClaimAccessBlockDto,
  RightsClaimAttachmentDto,
  RightsClaimComponentDto,
  RightsClaimDetailDto,
  RightsClaimEventDto,
  RightsClaimListResponseDto,
  RightsClaimSummaryDto,
} from './dto/rights-claim-response.dto';
import { ReopenRightsClaimDto, ResolveRightsClaimDto } from './dto/resolve-rights-claim.dto';
import {
  ALLOWED_STATUS_TRANSITIONS,
  CLAIM_DEADLINE_WARNING_DAYS,
  CLAIM_RECENTLY_RESOLVED_DAYS,
  CLAIM_SEVERITY_RANK,
  OPEN_CLAIM_STATUSES,
  PUBLICATION_BLOCKING_STATUSES,
  REOPENABLE_STATUSES,
  VERSION_SCOPED_BLOCK_SCOPES,
  isOpenClaimStatus,
} from './rights-claim.constants';
import {
  ClaimBlockScope,
  ClaimBookVersionDelegate,
  RightsClaimAccessBlockDelegate,
  RightsClaimAccessBlockRecord,
  RightsClaimAttachmentDelegate,
  RightsClaimAttachmentRecord,
  RightsClaimBlockStatus,
  RightsClaimComponentDelegate,
  RightsClaimComponentRecord,
  RightsClaimDelegate,
  RightsClaimEventDelegate,
  RightsClaimEventRecord,
  RightsClaimEventType,
  RightsClaimRecord,
  RightsClaimResolution,
  RightsClaimSeverity,
  RightsClaimStatus,
  toStringArray,
} from './rights-claim-interface';

const SUPPORTED_LANGUAGE_CODES = ['en', 'es', 'fr', 'pt', 'ru'];
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CLAIM_NUMBER_MAX_ATTEMPTS = 5;

/** The subset of the Prisma client the claims module reaches through dynamic delegates. */
export interface ClaimDatabaseClient {
  rightsClaim: RightsClaimDelegate;
  rightsClaimComponent: RightsClaimComponentDelegate;
  rightsClaimAccessBlock: RightsClaimAccessBlockDelegate;
  rightsClaimAttachment: RightsClaimAttachmentDelegate;
  rightsClaimEvent: RightsClaimEventDelegate;
  bookVersion: ClaimBookVersionDelegate;
  $transaction<T>(callback: (client: ClaimDatabaseClient) => Promise<T>): Promise<T>;
}

interface RecordEventOptions {
  previousStatus?: RightsClaimStatus | null;
  currentStatus?: RightsClaimStatus | null;
  notesRu?: string | null;
  payload?: Record<string, unknown>;
  userId?: string | null;
}

interface BlockTarget {
  bookId: string | null;
  bookVersionId: string | null;
  versionIdsToRecompute: string[];
}

/** Prisma signals a unique-constraint violation with error code `P2002`. */
const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error &&
  'code' in error &&
  (error as Error & { code?: unknown }).code === 'P2002';

/** Explicitly typed so TypeScript treats the call as never-returning and narrows afterwards. */
const fail: (code: string, messageRu: string) => never = (code, messageRu) => {
  throw new BadRequestException({ message: messageRu, code });
};

const failNotFound: (code: string, messageRu: string) => never = (code, messageRu) => {
  throw new NotFoundException({ message: messageRu, code });
};

@Injectable()
export class RightsClaimsService {
  constructor(private readonly prisma: PrismaService) {}

  private getDatabase(): ClaimDatabaseClient {
    return this.prisma as unknown as ClaimDatabaseClient;
  }

  private get claimDelegate(): RightsClaimDelegate {
    return this.getDatabase().rightsClaim;
  }

  private get componentDelegate(): RightsClaimComponentDelegate {
    return this.getDatabase().rightsClaimComponent;
  }

  private get blockDelegate(): RightsClaimAccessBlockDelegate {
    return this.getDatabase().rightsClaimAccessBlock;
  }

  private get attachmentDelegate(): RightsClaimAttachmentDelegate {
    return this.getDatabase().rightsClaimAttachment;
  }

  private get eventDelegate(): RightsClaimEventDelegate {
    return this.getDatabase().rightsClaimEvent;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  async findAll(query: QueryRightsClaimsDto): Promise<RightsClaimListResponseDto> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 100) : 20;

    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (query.claimType) where.claimType = query.claimType;
    if (query.severity) where.severity = query.severity;
    if (query.resolution) where.resolution = query.resolution;
    if (query.channel) where.channel = query.channel;
    if (query.claimantType) where.claimantType = query.claimantType;
    if (query.assignedToUserId) where.assignedToUserId = query.assignedToUserId;
    if (query.bookId) where.bookId = query.bookId;
    if (query.bookVersionId) where.bookVersionId = query.bookVersionId;
    if (query.rightsProfileId) where.rightsProfileId = query.rightsProfileId;
    if (query.requiresLawyerReview !== undefined) {
      where.requiresLawyerReview = query.requiresLawyerReview;
    }
    if (query.openOnly) where.status = { in: [...OPEN_CLAIM_STATUSES] };
    if (query.q) {
      const contains = { contains: query.q, mode: 'insensitive' };
      where.OR = [
        { claimNumber: contains },
        { claimantName: contains },
        { claimantOrganization: contains },
        { claimantEmail: contains },
        { claimedWorkTitle: contains },
        { claimedWorkAuthor: contains },
        { descriptionRu: contains },
      ];
    }
    if (query.receivedFrom || query.receivedTo) {
      const range: Record<string, Date> = {};
      if (query.receivedFrom) range.gte = new Date(query.receivedFrom);
      if (query.receivedTo) range.lte = new Date(query.receivedTo);
      where.receivedAt = range;
    }

    const claims = await this.claimDelegate.findMany({ where, orderBy: { receivedAt: 'desc' } });
    const blocksByClaim = await this.loadBlocksByClaim(claims.map((claim) => claim.id));

    const filtered = this.applyInMemoryFilters(claims, blocksByClaim, query);
    const sorted = this.sortClaims(filtered);
    const start = (page - 1) * limit;

    return {
      items: sorted
        .slice(start, start + limit)
        .map((claim) => this.mapSummary(claim, blocksByClaim.get(claim.id) ?? [])),
      total: sorted.length,
      page,
      limit,
    };
  }

  /**
   * JSON columns and access-block aggregates cannot be filtered in SQL through the dynamic
   * delegates, so these predicates run after the query and before paging.
   */
  private applyInMemoryFilters(
    claims: RightsClaimRecord[],
    blocksByClaim: Map<string, RightsClaimAccessBlockRecord[]>,
    query: QueryRightsClaimsDto,
  ): RightsClaimRecord[] {
    const now = new Date();
    let result = claims;

    if (query.countryCode) {
      const code = query.countryCode.toUpperCase();
      result = result.filter((claim) => {
        const codes = toStringArray(claim.affectedCountryCodes);
        // An empty list means the claim applies in every country.
        return codes.length === 0 || codes.some((item) => item.toUpperCase() === code);
      });
    }
    if (query.overdueOnly) {
      result = result.filter(
        (claim) =>
          isOpenClaimStatus(claim.status) &&
          claim.deadlineAt !== null &&
          claim.deadlineAt.getTime() < now.getTime(),
      );
    }
    if (query.hasActiveBlock) {
      result = result.filter(
        (claim) => this.activeBlocks(blocksByClaim.get(claim.id) ?? [], now).length > 0,
      );
    }
    if (query.deadlineWithinDays !== undefined) {
      const horizon = now.getTime() + query.deadlineWithinDays * MS_PER_DAY;
      result = result.filter(
        (claim) => claim.deadlineAt !== null && claim.deadlineAt.getTime() <= horizon,
      );
    }

    return result;
  }

  /** Severity desc, then deadline asc with nulls last, then most recently received first. */
  private sortClaims(claims: RightsClaimRecord[]): RightsClaimRecord[] {
    return [...claims].sort((left, right) => {
      const severity =
        (CLAIM_SEVERITY_RANK[right.severity] ?? 0) - (CLAIM_SEVERITY_RANK[left.severity] ?? 0);
      if (severity !== 0) return severity;

      const leftDeadline = left.deadlineAt ? left.deadlineAt.getTime() : Number.POSITIVE_INFINITY;
      const rightDeadline = right.deadlineAt
        ? right.deadlineAt.getTime()
        : Number.POSITIVE_INFINITY;
      if (leftDeadline !== rightDeadline) return leftDeadline - rightDeadline;

      return right.receivedAt.getTime() - left.receivedAt.getTime();
    });
  }

  async findOne(id: string): Promise<RightsClaimDetailDto> {
    const claim = await this.requireClaim(id);
    return this.buildDetail(claim);
  }

  async listForVersion(versionId: string): Promise<RightsClaimListResponseDto> {
    const version = await this.requireVersion(versionId);
    const claims = await this.claimDelegate.findMany({
      where: {
        OR: [{ bookVersionId: versionId }, { bookId: version.bookId, bookVersionId: null }],
      },
      orderBy: { receivedAt: 'desc' },
    });
    return this.asListResponse(claims);
  }

  async listForBook(bookId: string): Promise<RightsClaimListResponseDto> {
    const claims = await this.claimDelegate.findMany({
      where: { bookId },
      orderBy: { receivedAt: 'desc' },
    });
    return this.asListResponse(claims);
  }

  private async asListResponse(claims: RightsClaimRecord[]): Promise<RightsClaimListResponseDto> {
    const blocksByClaim = await this.loadBlocksByClaim(claims.map((claim) => claim.id));
    const items = this.sortClaims(claims).map((claim) =>
      this.mapSummary(claim, blocksByClaim.get(claim.id) ?? []),
    );
    return { items, total: items.length, page: 1, limit: items.length };
  }

  // ---------------------------------------------------------------------------
  // Creation and editing
  // ---------------------------------------------------------------------------

  async create(dto: CreateRightsClaimDto, userId: string): Promise<RightsClaimDetailDto> {
    if (!dto.bookId && !dto.bookVersionId) {
      fail('CLAIM_TARGET_REQUIRED', 'Претензия должна ссылаться на книгу или версию книги.');
    }

    const resolvedBookId = await this.resolveClaimTargets(dto);
    this.validatePayload(dto, null);

    const receivedAt = dto.receivedAt ? new Date(dto.receivedAt) : new Date();
    const data: Record<string, unknown> = {
      ...this.buildWriteData(dto),
      bookId: resolvedBookId,
      receivedAt,
      createdByUserId: userId,
    };

    const claim = await this.createWithClaimNumber(data, receivedAt.getUTCFullYear());
    await this.recordEvent(this.getDatabase(), claim.id, RightsClaimEventType.CREATED, {
      currentStatus: claim.status,
      userId,
      payload: { claimType: claim.claimType, severity: claim.severity },
    });

    return this.buildDetail(claim);
  }

  /**
   * Claim numbers are `CLM-<year>-<6 digits>`. Concurrent creation can collide on the unique
   * index, so a bounded retry walks the counter forward instead of failing the request.
   */
  private async createWithClaimNumber(
    data: Record<string, unknown>,
    year: number,
  ): Promise<RightsClaimRecord> {
    const prefix = `CLM-${year}-`;
    const existingCount = await this.claimDelegate.count({
      where: { claimNumber: { startsWith: prefix } },
    });

    for (let attempt = 0; attempt < CLAIM_NUMBER_MAX_ATTEMPTS; attempt += 1) {
      const claimNumber = `${prefix}${String(existingCount + 1 + attempt).padStart(6, '0')}`;
      try {
        return await this.claimDelegate.create({ data: { ...data, claimNumber } });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }

    throw new ConflictException({
      message: 'Не удалось сгенерировать уникальный номер претензии.',
      code: 'CLAIM_NUMBER_GENERATION_FAILED',
    });
  }

  async update(
    id: string,
    dto: Partial<CreateRightsClaimDto>,
    userId: string,
  ): Promise<RightsClaimDetailDto> {
    const existing = await this.requireClaim(id);

    if (existing.status === RightsClaimStatus.CLOSED) {
      const touchesMoreThanNotes = Object.keys(dto).some((key) => key !== 'internalNotesRu');
      if (touchesMoreThanNotes) {
        fail(
          'CLAIM_CLOSED_IMMUTABLE',
          'Закрытая претензия неизменяема — можно править только внутренние заметки.',
        );
      }
    }

    await this.resolveClaimTargets(dto);
    this.validatePayload(dto, existing);

    const updated = await this.claimDelegate.update({
      where: { id },
      data: this.buildWriteData(dto),
    });

    const database = this.getDatabase();
    await this.recordEvent(database, id, RightsClaimEventType.UPDATED, {
      previousStatus: existing.status,
      currentStatus: updated.status,
      userId,
      payload: { changedFields: Object.keys(dto) },
    });

    if (dto.deadlineAt !== undefined) {
      const previous = existing.deadlineAt ? existing.deadlineAt.toISOString() : null;
      const next = updated.deadlineAt ? updated.deadlineAt.toISOString() : null;
      if (previous !== next) {
        await this.recordEvent(database, id, RightsClaimEventType.DEADLINE_CHANGED, {
          currentStatus: updated.status,
          userId,
          payload: { previousDeadlineAt: previous, deadlineAt: next },
        });
      }
    }

    return this.buildDetail(updated);
  }

  async changeStatus(
    id: string,
    dto: ChangeRightsClaimStatusDto,
    userId: string,
  ): Promise<RightsClaimDetailDto> {
    const existing = await this.requireClaim(id);
    this.assertTransitionAllowed(existing.status, dto.status);

    const data: Record<string, unknown> = { status: dto.status };
    if (dto.status === RightsClaimStatus.CLOSED) data.closedAt = new Date();
    if (dto.status === RightsClaimStatus.ESCALATED_TO_LAWYER) data.requiresLawyerReview = true;

    const updated = await this.claimDelegate.update({ where: { id }, data });

    const database = this.getDatabase();
    await this.recordEvent(database, id, RightsClaimEventType.STATUS_CHANGED, {
      previousStatus: existing.status,
      currentStatus: updated.status,
      notesRu: dto.notesRu,
      userId,
    });
    if (dto.status === RightsClaimStatus.ESCALATED_TO_LAWYER) {
      await this.recordEvent(database, id, RightsClaimEventType.ESCALATED, {
        previousStatus: existing.status,
        currentStatus: updated.status,
        notesRu: dto.notesRu,
        userId,
      });
    }

    return this.buildDetail(updated);
  }

  async assign(
    id: string,
    dto: AssignRightsClaimDto,
    userId: string,
  ): Promise<RightsClaimDetailDto> {
    const existing = await this.requireClaim(id);

    if (dto.assignedToUserId) {
      const assignee = await this.prisma.user.findUnique({
        where: { id: dto.assignedToUserId },
        select: { id: true },
      });
      if (!assignee) {
        failNotFound('ASSIGNEE_NOT_FOUND', 'Пользователь-исполнитель не найден.');
      }
    }

    const updated = await this.claimDelegate.update({
      where: { id },
      data: { assignedToUserId: dto.assignedToUserId ?? null },
    });

    await this.recordEvent(this.getDatabase(), id, RightsClaimEventType.ASSIGNED, {
      previousStatus: existing.status,
      currentStatus: updated.status,
      notesRu: dto.notesRu,
      userId,
      payload: { assignedToUserId: dto.assignedToUserId ?? null },
    });

    return this.buildDetail(updated);
  }

  async recordResponse(
    id: string,
    dto: RecordClaimResponseDto,
    userId: string,
  ): Promise<RightsClaimDetailDto> {
    const existing = await this.requireClaim(id);
    this.assertClaimOpen(existing);

    if (!dto.responseTextRu || dto.responseTextRu.trim().length === 0) {
      fail('RESPONSE_TEXT_REQUIRED', 'Текст ответа заявителю обязателен.');
    }

    const updated = await this.claimDelegate.update({
      where: { id },
      data: {
        responseTextRu: dto.responseTextRu,
        responseChannel: dto.responseChannel ?? existing.channel,
        responseSentAt: dto.responseSentAt ? new Date(dto.responseSentAt) : new Date(),
        responseByUserId: userId,
      },
    });

    await this.recordEvent(this.getDatabase(), id, RightsClaimEventType.RESPONSE_RECORDED, {
      previousStatus: existing.status,
      currentStatus: updated.status,
      userId,
      payload: { responseChannel: updated.responseChannel },
    });

    return this.buildDetail(updated);
  }

  async recordCounterNotice(
    id: string,
    dto: RecordCounterNoticeDto,
    userId: string,
  ): Promise<RightsClaimDetailDto> {
    const existing = await this.requireClaim(id);
    this.assertClaimOpen(existing);

    if (!dto.counterNoticeTextRu || dto.counterNoticeTextRu.trim().length === 0) {
      fail('COUNTER_NOTICE_TEXT_REQUIRED', 'Текст встречного уведомления обязателен.');
    }

    const data: Record<string, unknown> = {
      counterNoticeTextRu: dto.counterNoticeTextRu,
      counterNoticeClaimantName: dto.counterNoticeClaimantName ?? existing.claimantName,
      counterNoticeReceivedAt: dto.counterNoticeReceivedAt
        ? new Date(dto.counterNoticeReceivedAt)
        : new Date(),
    };

    const movesToCounterNotice = this.isTransitionAllowed(
      existing.status,
      RightsClaimStatus.COUNTER_NOTICE_FILED,
    );
    if (movesToCounterNotice) data.status = RightsClaimStatus.COUNTER_NOTICE_FILED;

    const updated = await this.claimDelegate.update({ where: { id }, data });

    const database = this.getDatabase();
    await this.recordEvent(database, id, RightsClaimEventType.COUNTER_NOTICE_RECORDED, {
      previousStatus: existing.status,
      currentStatus: updated.status,
      userId,
    });
    if (movesToCounterNotice) {
      await this.recordEvent(database, id, RightsClaimEventType.STATUS_CHANGED, {
        previousStatus: existing.status,
        currentStatus: RightsClaimStatus.COUNTER_NOTICE_FILED,
        userId,
      });
    }

    return this.buildDetail(updated);
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  async resolve(
    id: string,
    dto: ResolveRightsClaimDto,
    userId: string,
  ): Promise<RightsClaimDetailDto> {
    const existing = await this.requireClaim(id);

    if (!dto.resolution) {
      fail('RESOLUTION_REQUIRED', 'Резолюция обязательна.');
    }
    if (!dto.resolutionNotesRu || dto.resolutionNotesRu.trim().length === 0) {
      fail('RESOLUTION_NOTES_REQUIRED', 'Комментарий к резолюции обязателен.');
    }
    if (existing.resolvedAt) {
      fail('CLAIM_ALREADY_RESOLVED', 'Претензия уже резолвлена.');
    }

    const finalStatus = dto.finalStatus ?? this.deriveResolutionStatus(dto.resolution);
    this.assertTransitionAllowed(existing.status, finalStatus);

    const resolvedAt = new Date();
    const database = this.getDatabase();

    const updated = await database.$transaction(async (transaction) => {
      const claim = await transaction.rightsClaim.update({
        where: { id },
        data: {
          status: finalStatus,
          resolution: dto.resolution,
          resolutionNotesRu: dto.resolutionNotesRu,
          resolvedAt,
          resolvedByUserId: userId,
        },
      });

      await this.recordEvent(transaction, id, RightsClaimEventType.RESOLVED, {
        previousStatus: existing.status,
        currentStatus: finalStatus,
        notesRu: dto.resolutionNotesRu,
        userId,
        payload: { resolution: dto.resolution, liftActiveBlocks: dto.liftActiveBlocks === true },
      });

      if (dto.liftActiveBlocks === true) {
        await this.liftAllActiveBlocks(
          transaction,
          id,
          `Претензия закрыта: ${dto.resolution}`,
          userId,
          finalStatus,
        );
      }

      return claim;
    });

    return this.buildDetail(updated);
  }

  async reopen(
    id: string,
    dto: ReopenRightsClaimDto,
    userId: string,
  ): Promise<RightsClaimDetailDto> {
    const existing = await this.requireClaim(id);

    if (!REOPENABLE_STATUSES.includes(existing.status)) {
      fail('CLAIM_NOT_RESOLVED', 'Переоткрыть можно только резолвленную или закрытую претензию.');
    }
    if (!dto.reasonRu || dto.reasonRu.trim().length === 0) {
      fail('REOPEN_REASON_REQUIRED', 'Причина переоткрытия обязательна.');
    }

    const updated = await this.claimDelegate.update({
      where: { id },
      data: {
        status: RightsClaimStatus.UNDER_REVIEW,
        resolution: null,
        resolutionNotesRu: null,
        resolvedAt: null,
        resolvedByUserId: null,
        closedAt: null,
      },
    });

    await this.recordEvent(this.getDatabase(), id, RightsClaimEventType.REOPENED, {
      previousStatus: existing.status,
      currentStatus: RightsClaimStatus.UNDER_REVIEW,
      notesRu: dto.reasonRu,
      userId,
    });

    return this.buildDetail(updated);
  }

  private deriveResolutionStatus(resolution: RightsClaimResolution): RightsClaimStatus {
    if (
      resolution === RightsClaimResolution.INVALID_REJECTED ||
      resolution === RightsClaimResolution.COUNTER_NOTICE_UPHELD
    ) {
      return RightsClaimStatus.RESOLVED_INVALID;
    }
    if (resolution === RightsClaimResolution.WITHDRAWN_BY_CLAIMANT) {
      return RightsClaimStatus.WITHDRAWN;
    }
    return RightsClaimStatus.RESOLVED_VALID;
  }

  // ---------------------------------------------------------------------------
  // Temporary access blocks
  // ---------------------------------------------------------------------------

  async applyBlock(
    id: string,
    dto: ApplyClaimBlockDto,
    userId: string,
  ): Promise<RightsClaimAccessBlockDto[]> {
    const claim = await this.requireClaim(id);
    this.assertClaimOpen(claim);

    if (!dto.reasonRu || dto.reasonRu.trim().length === 0) {
      fail('BLOCK_REASON_REQUIRED', 'Причина блокировки обязательна.');
    }

    const target = await this.resolveBlockTarget(claim, dto);
    const countryCodes = this.normaliseCountryCodes(dto.countryCodes);

    let expiresAt: Date | null = null;
    if (dto.expiresAt) {
      expiresAt = new Date(dto.expiresAt);
      if (expiresAt.getTime() <= Date.now()) {
        fail('BLOCK_EXPIRY_IN_PAST', 'Дата снятия блокировки должна быть в будущем.');
      }
    }

    const targets: Array<string | null> = countryCodes.length > 0 ? countryCodes : [null];
    const database = this.getDatabase();

    const blocks = await database.$transaction(async (transaction) => {
      const created: RightsClaimAccessBlockRecord[] = [];

      for (const countryCode of targets) {
        // NULL country codes compare as distinct in PostgreSQL, so deduplication is done here
        // rather than through a unique index.
        const existing = await transaction.rightsClaimAccessBlock.findFirst({
          where: {
            rightsClaimId: id,
            bookId: target.bookId,
            bookVersionId: target.bookVersionId,
            scope: dto.scope,
            countryCode,
            status: RightsClaimBlockStatus.ACTIVE,
          },
        });
        if (existing) {
          created.push(existing);
          continue;
        }

        created.push(
          await transaction.rightsClaimAccessBlock.create({
            data: {
              rightsClaimId: id,
              bookId: target.bookId,
              bookVersionId: target.bookVersionId,
              scope: dto.scope,
              countryCode,
              status: RightsClaimBlockStatus.ACTIVE,
              reasonRu: dto.reasonRu,
              appliedByUserId: userId,
              expiresAt,
            },
          }),
        );
      }

      if (dto.unpublishVersion === true) {
        await this.unpublishTargetVersions(transaction, id, target, userId, claim.status);
      }

      await this.recomputeVersionClaimFlags(transaction, target.versionIdsToRecompute);

      await this.recordEvent(transaction, id, RightsClaimEventType.BLOCK_APPLIED, {
        currentStatus: claim.status,
        notesRu: dto.reasonRu,
        userId,
        payload: {
          scope: dto.scope,
          countryCodes,
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
          unpublishVersion: dto.unpublishVersion === true,
          blockIds: created.map((block) => block.id),
        },
      });

      await this.advanceStatusAfterBlock(transaction, claim, dto.scope, countryCodes, userId);

      return created;
    });

    return blocks.map((block) => this.mapBlock(block));
  }

  async liftBlock(
    id: string,
    blockId: string,
    dto: LiftClaimBlockDto,
    userId: string,
  ): Promise<RightsClaimAccessBlockDto> {
    const claim = await this.requireClaim(id);

    const block = await this.blockDelegate.findFirst({
      where: { id: blockId, rightsClaimId: id },
    });
    if (!block) {
      failNotFound('BLOCK_NOT_FOUND', 'Блокировка не найдена для этой претензии.');
    }
    const found = block;

    if (found.status !== RightsClaimBlockStatus.ACTIVE) {
      fail('BLOCK_NOT_ACTIVE', 'Блокировка уже неактивна.');
    }
    if (!dto.liftReasonRu || dto.liftReasonRu.trim().length === 0) {
      fail('LIFT_REASON_REQUIRED', 'Причина снятия блокировки обязательна.');
    }

    const database = this.getDatabase();
    const lifted = await database.$transaction(async (transaction) => {
      const updated = await transaction.rightsClaimAccessBlock.update({
        where: { id: blockId },
        data: {
          status: RightsClaimBlockStatus.LIFTED,
          liftedAt: new Date(),
          liftedByUserId: userId,
          liftReasonRu: dto.liftReasonRu,
        },
      });

      await this.recomputeVersionClaimFlags(
        transaction,
        await this.versionIdsForBlock(transaction, found),
      );

      await this.recordEvent(transaction, id, RightsClaimEventType.BLOCK_LIFTED, {
        currentStatus: claim.status,
        notesRu: dto.liftReasonRu,
        userId,
        payload: { blockId, scope: found.scope, countryCode: found.countryCode },
      });

      return updated;
    });

    return this.mapBlock(lifted);
  }

  /** Lifts every still-active block of a claim. Used by `resolve({ liftActiveBlocks: true })`. */
  private async liftAllActiveBlocks(
    database: ClaimDatabaseClient,
    claimId: string,
    reasonRu: string,
    userId: string,
    currentStatus: RightsClaimStatus,
  ): Promise<void> {
    const blocks = await database.rightsClaimAccessBlock.findMany({
      where: { rightsClaimId: claimId, status: RightsClaimBlockStatus.ACTIVE },
    });
    if (blocks.length === 0) return;

    const liftedAt = new Date();
    const versionIds: string[] = [];

    for (const block of blocks) {
      await database.rightsClaimAccessBlock.update({
        where: { id: block.id },
        data: {
          status: RightsClaimBlockStatus.LIFTED,
          liftedAt,
          liftedByUserId: userId,
          liftReasonRu: reasonRu,
        },
      });
      await this.recordEvent(database, claimId, RightsClaimEventType.BLOCK_LIFTED, {
        currentStatus,
        notesRu: reasonRu,
        userId,
        payload: { blockId: block.id, scope: block.scope, countryCode: block.countryCode },
      });
      versionIds.push(...(await this.versionIdsForBlock(database, block)));
    }

    await this.recomputeVersionClaimFlags(database, versionIds);
  }

  private async resolveBlockTarget(
    claim: RightsClaimRecord,
    dto: ApplyClaimBlockDto,
  ): Promise<BlockTarget> {
    if (dto.scope === ClaimBlockScope.ENTIRE_BOOK) {
      const bookId = dto.bookId ?? claim.bookId;
      if (!bookId) {
        fail('BLOCK_SCOPE_REQUIRES_VERSION', 'Для скоупа ENTIRE_BOOK требуется книга.');
      }
      const book = await this.prisma.book.findUnique({
        where: { id: bookId },
        select: { id: true },
      });
      if (!book) {
        failNotFound('CLAIM_TARGET_NOT_FOUND', 'Книга для блокировки не найдена.');
      }
      const versions = await this.getDatabase().bookVersion.findMany({
        where: { bookId },
        select: { id: true, bookId: true, status: true },
      });
      return {
        bookId,
        bookVersionId: null,
        versionIdsToRecompute: versions.map((version) => version.id),
      };
    }

    const bookVersionId = dto.bookVersionId ?? claim.bookVersionId;
    if (!bookVersionId) {
      if (VERSION_SCOPED_BLOCK_SCOPES.includes(dto.scope)) {
        fail(
          'BLOCK_SCOPE_REQUIRES_VERSION',
          `Для скоупа ${dto.scope} требуется указать версию книги.`,
        );
      }
      fail('BLOCK_SCOPE_REQUIRES_VERSION', 'Для блокировки требуется указать версию книги.');
    }

    const version = await this.getDatabase().bookVersion.findUnique({
      where: { id: bookVersionId },
      select: { id: true, bookId: true, status: true },
    });
    if (!version) {
      failNotFound('CLAIM_TARGET_NOT_FOUND', 'Версия книги для блокировки не найдена.');
    }

    return {
      bookId: dto.bookId ?? claim.bookId ?? version.bookId,
      bookVersionId: version.id,
      versionIdsToRecompute: [version.id],
    };
  }

  private async unpublishTargetVersions(
    database: ClaimDatabaseClient,
    claimId: string,
    target: BlockTarget,
    userId: string,
    currentStatus: RightsClaimStatus,
  ): Promise<void> {
    const versions = await database.bookVersion.findMany({
      where: { id: { in: target.versionIdsToRecompute } },
      select: { id: true, bookId: true, status: true },
    });

    for (const version of versions) {
      if (version.status !== 'published') continue;
      await database.bookVersion.update({
        where: { id: version.id },
        data: { status: 'draft' },
      });
      await this.recordEvent(database, claimId, RightsClaimEventType.VERSION_UNPUBLISHED, {
        currentStatus,
        userId,
        payload: { bookVersionId: version.id },
      });
    }
  }

  /**
   * A fresh claim moves itself into a restricted state once a block is applied, so the
   * workflow status always matches what the public site actually serves.
   */
  private async advanceStatusAfterBlock(
    database: ClaimDatabaseClient,
    claim: RightsClaimRecord,
    scope: ClaimBlockScope,
    countryCodes: string[],
    userId: string,
  ): Promise<void> {
    if (
      claim.status !== RightsClaimStatus.RECEIVED &&
      claim.status !== RightsClaimStatus.UNDER_REVIEW
    ) {
      return;
    }

    const isWorldwide = countryCodes.length === 0;
    const removesWholeEdition =
      scope === ClaimBlockScope.ENTIRE_BOOK || scope === ClaimBlockScope.LANGUAGE_EDITION;
    const nextStatus =
      isWorldwide && removesWholeEdition
        ? RightsClaimStatus.CONTENT_REMOVED
        : RightsClaimStatus.CONTENT_RESTRICTED;

    if (!this.isTransitionAllowed(claim.status, nextStatus)) return;

    await database.rightsClaim.update({ where: { id: claim.id }, data: { status: nextStatus } });
    await this.recordEvent(database, claim.id, RightsClaimEventType.STATUS_CHANGED, {
      previousStatus: claim.status,
      currentStatus: nextStatus,
      userId,
      payload: { reason: 'BLOCK_APPLIED' },
    });
  }

  /**
   * Keeps `BookVersion.rightsClaimBlockActive` in sync. The flag is a read optimisation only —
   * runtime enforcement always re-checks `RightsClaimAccessBlock`.
   */
  private async recomputeVersionClaimFlags(
    database: ClaimDatabaseClient,
    versionIds: string[],
  ): Promise<void> {
    const unique = Array.from(new Set(versionIds));
    if (unique.length === 0) return;

    const versions = await database.bookVersion.findMany({
      where: { id: { in: unique } },
      select: { id: true, bookId: true, status: true },
    });
    const now = new Date();

    for (const version of versions) {
      const blocks = await database.rightsClaimAccessBlock.findMany({
        where: {
          status: RightsClaimBlockStatus.ACTIVE,
          OR: [
            { bookVersionId: version.id },
            { bookId: version.bookId, scope: ClaimBlockScope.ENTIRE_BOOK },
          ],
        },
      });
      const active = this.activeBlocks(blocks, now);
      const appliedAt =
        active.length > 0
          ? new Date(Math.min(...active.map((block) => block.appliedAt.getTime())))
          : null;

      await database.bookVersion.update({
        where: { id: version.id },
        data: {
          rightsClaimBlockActive: active.length > 0,
          rightsClaimBlockAppliedAt: appliedAt,
        },
      });
    }
  }

  private async versionIdsForBlock(
    database: ClaimDatabaseClient,
    block: RightsClaimAccessBlockRecord,
  ): Promise<string[]> {
    if (block.bookVersionId) return [block.bookVersionId];
    if (!block.bookId) return [];
    const versions = await database.bookVersion.findMany({
      where: { bookId: block.bookId },
      select: { id: true, bookId: true, status: true },
    });
    return versions.map((version) => version.id);
  }

  // ---------------------------------------------------------------------------
  // Affected components
  // ---------------------------------------------------------------------------

  async linkComponent(
    id: string,
    dto: LinkClaimComponentDto,
    userId: string,
  ): Promise<RightsClaimComponentDto> {
    const claim = await this.requireClaim(id);

    if (!dto.rightsComponentId && !dto.componentType) {
      fail(
        'COMPONENT_REFERENCE_REQUIRED',
        'Нужно указать компонент профиля прав или тип компонента.',
      );
    }

    if (dto.rightsComponentId) {
      const component = await this.prisma.rightsComponent.findUnique({
        where: { id: dto.rightsComponentId },
        select: { id: true, rightsProfileId: true },
      });
      if (!component) {
        failNotFound('CLAIM_TARGET_NOT_FOUND', 'Компонент профиля прав не найден.');
      }
      if (claim.rightsProfileId && component.rightsProfileId !== claim.rightsProfileId) {
        fail(
          'COMPONENT_NOT_IN_PROFILE',
          'Компонент не принадлежит профилю прав, указанному в претензии.',
        );
      }
    }

    const created = await this.componentDelegate.create({
      data: {
        rightsClaimId: id,
        rightsComponentId: dto.rightsComponentId ?? null,
        componentType: dto.componentType ?? null,
        titleRu: dto.titleRu ?? null,
        notesRu: dto.notesRu ?? null,
      },
    });

    await this.recordEvent(this.getDatabase(), id, RightsClaimEventType.COMPONENT_LINKED, {
      currentStatus: claim.status,
      userId,
      payload: {
        claimComponentId: created.id,
        rightsComponentId: created.rightsComponentId,
        componentType: created.componentType,
      },
    });

    return this.mapComponent(created);
  }

  async unlinkComponent(
    id: string,
    claimComponentId: string,
    userId: string,
  ): Promise<ClaimMutationResultDto> {
    const claim = await this.requireClaim(id);

    const link = await this.componentDelegate.findFirst({
      where: { id: claimComponentId, rightsClaimId: id },
    });
    if (!link) {
      failNotFound('CLAIM_TARGET_NOT_FOUND', 'Связь с компонентом не найдена.');
    }

    await this.componentDelegate.delete({ where: { id: claimComponentId } });
    await this.recordEvent(this.getDatabase(), id, RightsClaimEventType.COMPONENT_UNLINKED, {
      currentStatus: claim.status,
      userId,
      payload: { claimComponentId },
    });

    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Attachments
  // ---------------------------------------------------------------------------

  async addAttachment(
    id: string,
    dto: CreateClaimAttachmentDto,
    userId: string,
  ): Promise<RightsClaimAttachmentDto> {
    const claim = await this.requireClaim(id);

    if (!dto.mediaAssetId && !dto.storageKey && !dto.url) {
      fail(
        'ATTACHMENT_SOURCE_REQUIRED',
        'Нужно указать mediaAssetId, storageKey или url вложения.',
      );
    }
    if (dto.sha256 && !SHA256_PATTERN.test(dto.sha256)) {
      fail('INVALID_ATTACHMENT_SHA256', 'sha256 должен состоять из 64 hex-символов.');
    }
    if (dto.url) this.assertHttpUrl(dto.url);

    if (dto.mediaAssetId) {
      const asset = await this.prisma.mediaAsset.findUnique({
        where: { id: dto.mediaAssetId },
        select: { id: true, isDeleted: true },
      });
      if (!asset || asset.isDeleted) {
        failNotFound('MEDIA_ASSET_NOT_FOUND', 'Медиа-ассет не найден или удалён.');
      }
    }

    const created = await this.attachmentDelegate.create({
      data: {
        rightsClaimId: id,
        attachmentType: dto.attachmentType,
        title: dto.title,
        fileName: dto.fileName ?? null,
        mediaAssetId: dto.mediaAssetId ?? null,
        storageKey: dto.storageKey ?? null,
        url: dto.url ?? null,
        sha256: dto.sha256 ?? null,
        contentType: dto.contentType ?? null,
        sizeBytes: dto.sizeBytes ?? null,
        notesRu: dto.notesRu ?? null,
        uploadedByUserId: userId,
      },
    });

    await this.recordEvent(this.getDatabase(), id, RightsClaimEventType.ATTACHMENT_ADDED, {
      currentStatus: claim.status,
      userId,
      payload: { attachmentId: created.id, attachmentType: created.attachmentType },
    });

    return this.mapAttachment(created);
  }

  /** Attachments are soft-deleted: claim materials are never physically removed. */
  async removeAttachment(
    id: string,
    attachmentId: string,
    userId: string,
  ): Promise<ClaimMutationResultDto> {
    const claim = await this.requireClaim(id);

    const attachment = await this.attachmentDelegate.findFirst({
      where: { id: attachmentId, rightsClaimId: id },
    });
    if (!attachment || attachment.isDeleted) {
      failNotFound('CLAIM_TARGET_NOT_FOUND', 'Вложение не найдено.');
    }

    await this.attachmentDelegate.update({
      where: { id: attachmentId },
      data: { isDeleted: true, removedAt: new Date(), removedByUserId: userId },
    });
    await this.recordEvent(this.getDatabase(), id, RightsClaimEventType.ATTACHMENT_REMOVED, {
      currentStatus: claim.status,
      userId,
      payload: { attachmentId },
    });

    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Publication gate evaluation
  // ---------------------------------------------------------------------------

  async evaluateVersionClaims(versionId: string): Promise<ClaimGateEvaluationDto> {
    const version = await this.requireVersion(versionId);
    const now = new Date();

    // Claims filed against the book as a whole affect every one of its versions.
    const claims = await this.claimDelegate.findMany({
      where: {
        OR: [{ bookVersionId: versionId }, { bookId: version.bookId, bookVersionId: null }],
      },
    });

    const blockers: ClaimIssueDto[] = [];
    const warnings: ClaimIssueDto[] = [];

    const openClaims = claims.filter((claim) => isOpenClaimStatus(claim.status));
    const blockingClaims = openClaims.filter(
      (claim) => claim.blocksPublication && PUBLICATION_BLOCKING_STATUSES.includes(claim.status),
    );
    const criticalClaims = openClaims.filter(
      (claim) => claim.severity === RightsClaimSeverity.CRITICAL,
    );
    const overdueClaims = openClaims.filter(
      (claim) => claim.deadlineAt !== null && claim.deadlineAt.getTime() < now.getTime(),
    );
    const lawyerClaims = openClaims.filter((claim) => claim.requiresLawyerReview);

    if (blockingClaims.length > 0) {
      blockers.push({
        code: 'ACTIVE_RIGHTS_CLAIM',
        severity: 'BLOCKER',
        messageRu: `Публикация заблокирована активной претензией ${this.describeClaims(blockingClaims)}.`,
        claimId: blockingClaims[0].id,
        claimNumber: blockingClaims[0].claimNumber,
        details: {
          claimIds: blockingClaims.map((claim) => claim.id),
          count: blockingClaims.length,
        },
      });
    }

    for (const claim of criticalClaims) {
      blockers.push({
        code: 'CRITICAL_RIGHTS_CLAIM_UNRESOLVED',
        severity: 'BLOCKER',
        messageRu: `Есть нерешённая критичная претензия ${claim.claimNumber} (${claim.claimType}).`,
        claimId: claim.id,
        claimNumber: claim.claimNumber,
      });
    }

    for (const claim of overdueClaims) {
      blockers.push({
        code: 'RIGHTS_CLAIM_DEADLINE_OVERDUE',
        severity: 'BLOCKER',
        messageRu: `Просрочен срок ответа по претензии ${claim.claimNumber}.`,
        claimId: claim.id,
        claimNumber: claim.claimNumber,
      });
    }

    for (const claim of lawyerClaims) {
      blockers.push({
        code: 'RIGHTS_CLAIM_REQUIRES_LAWYER_REVIEW',
        severity: 'BLOCKER',
        messageRu: `Претензия ${claim.claimNumber} требует юридической проверки.`,
        claimId: claim.id,
        claimNumber: claim.claimNumber,
      });
    }

    const claimIds = claims.map((claim) => claim.id);
    const activeBlocks =
      claimIds.length > 0
        ? this.activeBlocks(
            await this.blockDelegate.findMany({
              where: {
                rightsClaimId: { in: claimIds },
                status: RightsClaimBlockStatus.ACTIVE,
                OR: [
                  { bookVersionId: versionId },
                  { bookId: version.bookId, scope: ClaimBlockScope.ENTIRE_BOOK },
                ],
              },
            }),
            now,
          )
        : [];

    const worldwideBlocks = activeBlocks.filter((block) => block.countryCode === null);
    const countryBlocks = activeBlocks.filter((block) => block.countryCode !== null);
    const fullEditionBlock = worldwideBlocks.find(
      (block) =>
        block.scope === ClaimBlockScope.ENTIRE_BOOK ||
        block.scope === ClaimBlockScope.LANGUAGE_EDITION,
    );

    if (fullEditionBlock) {
      blockers.push({
        code: 'RIGHTS_CLAIM_ACCESS_BLOCK_ACTIVE',
        severity: 'BLOCKER',
        messageRu:
          'Версия полностью недоступна: действует всемирная блокировка по претензии правообладателя.',
        details: { blockId: fullEditionBlock.id, scope: fullEditionBlock.scope },
      });
    }

    for (const claim of openClaims.filter((item) => !item.blocksPublication)) {
      warnings.push({
        code: 'RIGHTS_CLAIM_OPEN_NON_BLOCKING',
        severity: 'WARNING',
        messageRu: `Открытая претензия ${claim.claimNumber} помечена как не блокирующая публикацию.`,
        claimId: claim.id,
        claimNumber: claim.claimNumber,
      });
    }

    for (const claim of openClaims) {
      const days = this.daysUntilDeadline(claim.deadlineAt, now);
      if (days !== null && days >= 0 && days <= CLAIM_DEADLINE_WARNING_DAYS) {
        warnings.push({
          code: 'RIGHTS_CLAIM_DEADLINE_SOON',
          severity: 'WARNING',
          messageRu: `Срок ответа по претензии ${claim.claimNumber} истекает через ${days} дн.`,
          claimId: claim.id,
          claimNumber: claim.claimNumber,
        });
      }
      if (claim.status === RightsClaimStatus.COUNTER_NOTICE_FILED) {
        warnings.push({
          code: 'RIGHTS_CLAIM_COUNTER_NOTICE_PENDING',
          severity: 'WARNING',
          messageRu: `По претензии ${claim.claimNumber} подано встречное уведомление.`,
          claimId: claim.id,
          claimNumber: claim.claimNumber,
        });
      }
    }

    if (countryBlocks.length > 0) {
      const countryCodes = this.uniqueSorted(
        countryBlocks.map((block) => block.countryCode as string),
      );
      warnings.push({
        code: 'RIGHTS_CLAIM_PARTIAL_GEO_BLOCK_ACTIVE',
        severity: 'WARNING',
        messageRu: `Действуют страновые блокировки по претензиям: ${countryCodes.join(', ')}.`,
        details: { countryCodes },
      });
    }

    for (const claim of claims) {
      if (!claim.resolvedAt) continue;
      const daysSince = (now.getTime() - claim.resolvedAt.getTime()) / MS_PER_DAY;
      if (daysSince >= 0 && daysSince < CLAIM_RECENTLY_RESOLVED_DAYS) {
        warnings.push({
          code: 'RIGHTS_CLAIM_RECENTLY_RESOLVED',
          severity: 'WARNING',
          messageRu: `Претензия ${claim.claimNumber} была закрыта менее ${CLAIM_RECENTLY_RESOLVED_DAYS} дней назад.`,
          claimId: claim.id,
          claimNumber: claim.claimNumber,
        });
      }
    }

    return {
      activeClaimsCount: openClaims.length,
      blockingClaimsCount: blockingClaims.length,
      criticalClaimsCount: criticalClaims.length,
      overdueClaimsCount: overdueClaims.length,
      activeBlocksCount: activeBlocks.length,
      hasWorldwideBlock: worldwideBlocks.length > 0,
      claimBlockedCountryCodes: this.uniqueSorted(
        countryBlocks.map((block) => block.countryCode as string),
      ),
      worstSeverity: this.worstSeverity(openClaims),
      claimIds,
      blockers,
      warnings,
    };
  }

  private describeClaims(claims: RightsClaimRecord[]): string {
    const first = claims[0];
    const suffix = claims.length > 1 ? ` и ещё ${claims.length - 1}` : '';
    return `${first.claimNumber} (${first.claimType})${suffix}`;
  }

  private worstSeverity(claims: RightsClaimRecord[]): RightsClaimSeverity | null {
    let worst: RightsClaimSeverity | null = null;
    for (const claim of claims) {
      const rank = CLAIM_SEVERITY_RANK[claim.severity] ?? 0;
      const worstRank = worst ? (CLAIM_SEVERITY_RANK[worst] ?? 0) : -1;
      if (rank > worstRank) worst = claim.severity;
    }
    return worst;
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  private validatePayload(
    dto: Partial<CreateRightsClaimDto>,
    existing: RightsClaimRecord | null,
  ): void {
    const claimantName = dto.claimantName ?? existing?.claimantName;
    if (!claimantName || claimantName.trim().length === 0) {
      fail('CLAIMANT_NAME_REQUIRED', 'Имя заявителя обязательно.');
    }

    const descriptionRu = dto.descriptionRu ?? existing?.descriptionRu;
    if (!descriptionRu || descriptionRu.trim().length === 0) {
      fail('DESCRIPTION_REQUIRED', 'Описание претензии обязательно.');
    }

    const countryCodes = dto.affectedCountryCodes ?? toStringArray(existing?.affectedCountryCodes);
    for (const code of countryCodes) {
      if (!COUNTRY_CODE_PATTERN.test(code.toUpperCase())) {
        fail('INVALID_COUNTRY_CODE', `Некорректный код страны: ${code}.`);
      }
    }

    const languages = dto.affectedLanguages ?? toStringArray(existing?.affectedLanguages);
    for (const language of languages) {
      if (!SUPPORTED_LANGUAGE_CODES.includes(language.toLowerCase())) {
        fail('INVALID_LANGUAGE_CODE', `Некорректный код языка: ${language}.`);
      }
    }

    const urls = dto.infringingUrls ?? toStringArray(existing?.infringingUrls);
    for (const url of urls) this.assertHttpUrl(url);
    if (dto.originalNoticeUrl) this.assertHttpUrl(dto.originalNoticeUrl);

    const receivedAt = dto.receivedAt ? new Date(dto.receivedAt) : (existing?.receivedAt ?? null);
    if (dto.receivedAt && receivedAt && receivedAt.getTime() > Date.now() + MS_PER_DAY) {
      fail('RECEIVED_IN_FUTURE', 'Дата получения претензии не может быть в будущем.');
    }

    const deadlineAt = dto.deadlineAt ? new Date(dto.deadlineAt) : (existing?.deadlineAt ?? null);
    if (deadlineAt && receivedAt && deadlineAt.getTime() <= receivedAt.getTime()) {
      fail('DEADLINE_BEFORE_RECEIVED', 'Дедлайн должен быть позже даты получения претензии.');
    }

    const blocksPublication = dto.blocksPublication ?? existing?.blocksPublication ?? true;
    const overrideReason =
      dto.blocksPublicationOverrideReasonRu ?? existing?.blocksPublicationOverrideReasonRu ?? null;
    if (!blocksPublication && (!overrideReason || overrideReason.trim().length === 0)) {
      fail(
        'BLOCK_OVERRIDE_REASON_REQUIRED',
        'Снятие блокировки публикации требует указания причины.',
      );
    }
  }

  private assertHttpUrl(url: string): void {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      fail('INVALID_URL', `Некорректный URL: ${url}.`);
    }
  }

  /** Verifies every referenced entity exists and returns the effective bookId. */
  private async resolveClaimTargets(dto: Partial<CreateRightsClaimDto>): Promise<string | null> {
    let bookId = dto.bookId ?? null;

    if (dto.bookVersionId) {
      const version = await this.getDatabase().bookVersion.findUnique({
        where: { id: dto.bookVersionId },
        select: { id: true, bookId: true, status: true },
      });
      if (!version) {
        failNotFound('CLAIM_TARGET_NOT_FOUND', 'Версия книги не найдена.');
      }
      bookId = bookId ?? version.bookId;
    }

    if (dto.bookId) {
      const book = await this.prisma.book.findUnique({
        where: { id: dto.bookId },
        select: { id: true },
      });
      if (!book) failNotFound('CLAIM_TARGET_NOT_FOUND', 'Книга не найдена.');
    }

    if (dto.rightsProfileId) {
      const profile = await this.prisma.rightsProfile.findUnique({
        where: { id: dto.rightsProfileId },
        select: { id: true },
      });
      if (!profile) failNotFound('CLAIM_TARGET_NOT_FOUND', 'Профиль прав не найден.');
    }

    if (dto.rightsIntakeId) {
      const intake = await this.prisma.rightsIntake.findUnique({
        where: { id: dto.rightsIntakeId },
        select: { id: true },
      });
      if (!intake) failNotFound('CLAIM_TARGET_NOT_FOUND', 'Rights intake не найден.');
    }

    if (dto.mediaAssetId) {
      const asset = await this.prisma.mediaAsset.findUnique({
        where: { id: dto.mediaAssetId },
        select: { id: true, isDeleted: true },
      });
      if (!asset || asset.isDeleted) {
        failNotFound('CLAIM_TARGET_NOT_FOUND', 'Медиа-ассет не найден.');
      }
    }

    if (dto.assignedToUserId) {
      const assignee = await this.prisma.user.findUnique({
        where: { id: dto.assignedToUserId },
        select: { id: true },
      });
      if (!assignee) failNotFound('ASSIGNEE_NOT_FOUND', 'Пользователь-исполнитель не найден.');
    }

    if (dto.parentClaimId) {
      const parent = await this.claimDelegate.findUnique({ where: { id: dto.parentClaimId } });
      if (!parent) failNotFound('PARENT_CLAIM_NOT_FOUND', 'Родительская претензия не найдена.');
    }

    return bookId;
  }

  private assertTransitionAllowed(from: RightsClaimStatus, to: RightsClaimStatus): void {
    if (from === to) return;
    if (this.isTransitionAllowed(from, to)) return;

    throw new BadRequestException({
      message: `Недопустимый переход статуса претензии: ${from} → ${to}.`,
      code: 'INVALID_STATUS_TRANSITION',
      details: { from, to, allowed: ALLOWED_STATUS_TRANSITIONS[from] ?? [] },
    });
  }

  private isTransitionAllowed(from: RightsClaimStatus, to: RightsClaimStatus): boolean {
    return (ALLOWED_STATUS_TRANSITIONS[from] ?? []).includes(to);
  }

  private assertClaimOpen(claim: RightsClaimRecord): void {
    if (!isOpenClaimStatus(claim.status)) {
      fail('CLAIM_NOT_OPEN', `Претензия закрыта (статус ${claim.status}).`);
    }
  }

  private async requireClaim(id: string): Promise<RightsClaimRecord> {
    const claim = await this.claimDelegate.findUnique({ where: { id } });
    if (!claim) throw new NotFoundException('RightsClaim not found');
    return claim;
  }

  private async requireVersion(versionId: string): Promise<{ id: string; bookId: string }> {
    const version = await this.getDatabase().bookVersion.findUnique({
      where: { id: versionId },
      select: { id: true, bookId: true, status: true },
    });
    if (!version) throw new NotFoundException('BookVersion not found');
    return { id: version.id, bookId: version.bookId };
  }

  private normaliseCountryCodes(codes: string[] | undefined): string[] {
    if (!codes || codes.length === 0) return [];
    const normalised = codes.map((code) => code.trim().toUpperCase());
    for (const code of normalised) {
      if (!COUNTRY_CODE_PATTERN.test(code)) {
        fail('INVALID_COUNTRY_CODE', `Некорректный код страны: ${code}.`);
      }
    }
    return this.uniqueSorted(normalised);
  }

  private uniqueSorted(values: string[]): string[] {
    return Array.from(new Set(values)).sort();
  }

  // ---------------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------------

  private buildWriteData(dto: Partial<CreateRightsClaimDto>): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    const assign = (key: string, value: unknown): void => {
      if (value !== undefined) data[key] = value;
    };

    assign('claimType', dto.claimType);
    assign('severity', dto.severity);
    assign('channel', dto.channel);
    assign('deadlineAt', dto.deadlineAt ? new Date(dto.deadlineAt) : undefined);
    assign('claimantName', dto.claimantName);
    assign('claimantType', dto.claimantType);
    assign('claimantOrganization', dto.claimantOrganization);
    assign('claimantEmail', dto.claimantEmail);
    assign('claimantPhone', dto.claimantPhone);
    assign('claimantAddress', dto.claimantAddress);
    assign('claimantIsAuthorized', dto.claimantIsAuthorized);
    assign('claimantPersonId', dto.claimantPersonId);
    assign('bookVersionId', dto.bookVersionId);
    assign('rightsProfileId', dto.rightsProfileId);
    assign('rightsIntakeId', dto.rightsIntakeId);
    assign('mediaAssetId', dto.mediaAssetId);
    assign('parentClaimId', dto.parentClaimId);
    assign(
      'affectedCountryCodes',
      dto.affectedCountryCodes
        ? dto.affectedCountryCodes.map((code) => code.toUpperCase())
        : undefined,
    );
    assign(
      'affectedLanguages',
      dto.affectedLanguages ? dto.affectedLanguages.map((code) => code.toLowerCase()) : undefined,
    );
    assign('claimedWorkTitle', dto.claimedWorkTitle);
    assign('claimedWorkAuthor', dto.claimedWorkAuthor);
    assign('claimedRightsDescriptionRu', dto.claimedRightsDescriptionRu);
    assign('descriptionRu', dto.descriptionRu);
    assign('infringingUrls', dto.infringingUrls);
    assign('goodFaithStatement', dto.goodFaithStatement);
    assign('swornStatement', dto.swornStatement);
    assign('originalNoticeText', dto.originalNoticeText);
    assign('originalNoticeUrl', dto.originalNoticeUrl);
    assign('assignedToUserId', dto.assignedToUserId);
    assign('internalNotesRu', dto.internalNotesRu);
    assign('blocksPublication', dto.blocksPublication);
    assign('blocksPublicationOverrideReasonRu', dto.blocksPublicationOverrideReasonRu);
    assign('requiresLawyerReview', dto.requiresLawyerReview);

    return data;
  }

  private async recordEvent(
    database: ClaimDatabaseClient,
    rightsClaimId: string,
    eventType: RightsClaimEventType,
    options: RecordEventOptions,
  ): Promise<void> {
    await database.rightsClaimEvent.create({
      data: {
        rightsClaimId,
        eventType,
        previousStatus: options.previousStatus ?? null,
        currentStatus: options.currentStatus ?? null,
        notesRu: options.notesRu ?? null,
        payload: options.payload,
        createdByUserId: options.userId ?? null,
      },
    });
  }

  private async loadBlocksByClaim(
    claimIds: string[],
  ): Promise<Map<string, RightsClaimAccessBlockRecord[]>> {
    const grouped = new Map<string, RightsClaimAccessBlockRecord[]>();
    if (claimIds.length === 0) return grouped;

    const blocks = await this.blockDelegate.findMany({
      where: { rightsClaimId: { in: claimIds } },
      orderBy: { appliedAt: 'desc' },
    });
    for (const block of blocks) {
      const bucket = grouped.get(block.rightsClaimId);
      if (bucket) bucket.push(block);
      else grouped.set(block.rightsClaimId, [block]);
    }
    return grouped;
  }

  private activeBlocks(
    blocks: RightsClaimAccessBlockRecord[],
    at: Date,
  ): RightsClaimAccessBlockRecord[] {
    return blocks.filter(
      (block) =>
        block.status === RightsClaimBlockStatus.ACTIVE &&
        (block.expiresAt === null || block.expiresAt.getTime() > at.getTime()),
    );
  }

  private daysUntilDeadline(deadlineAt: Date | null, at: Date): number | null {
    if (!deadlineAt) return null;
    return Math.ceil((deadlineAt.getTime() - at.getTime()) / MS_PER_DAY);
  }

  // ---------------------------------------------------------------------------
  // Mapping
  // ---------------------------------------------------------------------------

  mapSummary(
    claim: RightsClaimRecord,
    blocks: RightsClaimAccessBlockRecord[],
    at: Date = new Date(),
  ): RightsClaimSummaryDto {
    const active = this.activeBlocks(blocks, at);
    const isOpen = isOpenClaimStatus(claim.status);

    return {
      id: claim.id,
      claimNumber: claim.claimNumber,
      claimType: claim.claimType,
      status: claim.status,
      severity: claim.severity,
      channel: claim.channel,
      receivedAt: claim.receivedAt.toISOString(),
      deadlineAt: this.toIso(claim.deadlineAt),
      resolvedAt: this.toIso(claim.resolvedAt),
      closedAt: this.toIso(claim.closedAt),
      claimantName: claim.claimantName,
      claimantType: claim.claimantType,
      claimantOrganization: claim.claimantOrganization,
      claimantEmail: claim.claimantEmail,
      claimantIsAuthorized: claim.claimantIsAuthorized,
      bookId: claim.bookId,
      bookVersionId: claim.bookVersionId,
      rightsProfileId: claim.rightsProfileId,
      rightsIntakeId: claim.rightsIntakeId,
      affectedCountryCodes: toStringArray(claim.affectedCountryCodes),
      affectedLanguages: toStringArray(claim.affectedLanguages),
      claimedWorkTitle: claim.claimedWorkTitle,
      claimedWorkAuthor: claim.claimedWorkAuthor,
      descriptionRu: claim.descriptionRu,
      assignedToUserId: claim.assignedToUserId,
      blocksPublication: claim.blocksPublication,
      requiresLawyerReview: claim.requiresLawyerReview,
      resolution: claim.resolution,
      isOpen,
      isOverdue: isOpen && claim.deadlineAt !== null && claim.deadlineAt.getTime() < at.getTime(),
      daysUntilDeadline: this.daysUntilDeadline(claim.deadlineAt, at),
      activeBlocksCount: active.length,
      hasWorldwideBlock: active.some((block) => block.countryCode === null),
      blockedCountryCodes: this.uniqueSorted(
        active
          .map((block) => block.countryCode)
          .filter((code): code is string => typeof code === 'string'),
      ),
      createdAt: claim.createdAt.toISOString(),
      updatedAt: claim.updatedAt.toISOString(),
    };
  }

  private async buildDetail(claim: RightsClaimRecord): Promise<RightsClaimDetailDto> {
    const [components, blocks, attachments, events] = await Promise.all([
      this.componentDelegate.findMany({
        where: { rightsClaimId: claim.id },
        orderBy: { createdAt: 'asc' },
      }),
      this.blockDelegate.findMany({
        where: { rightsClaimId: claim.id },
        orderBy: { appliedAt: 'desc' },
      }),
      this.attachmentDelegate.findMany({
        where: { rightsClaimId: claim.id, isDeleted: false },
        orderBy: { createdAt: 'asc' },
      }),
      this.eventDelegate.findMany({
        where: { rightsClaimId: claim.id },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      ...this.mapSummary(claim, blocks),
      claimantPhone: claim.claimantPhone,
      claimantAddress: claim.claimantAddress,
      claimantPersonId: claim.claimantPersonId,
      mediaAssetId: claim.mediaAssetId,
      claimedRightsDescriptionRu: claim.claimedRightsDescriptionRu,
      infringingUrls: toStringArray(claim.infringingUrls),
      goodFaithStatement: claim.goodFaithStatement,
      swornStatement: claim.swornStatement,
      originalNoticeText: claim.originalNoticeText,
      originalNoticeUrl: claim.originalNoticeUrl,
      internalNotesRu: claim.internalNotesRu,
      blocksPublicationOverrideReasonRu: claim.blocksPublicationOverrideReasonRu,
      responseSentAt: this.toIso(claim.responseSentAt),
      responseChannel: claim.responseChannel,
      responseTextRu: claim.responseTextRu,
      responseByUserId: claim.responseByUserId,
      counterNoticeReceivedAt: this.toIso(claim.counterNoticeReceivedAt),
      counterNoticeClaimantName: claim.counterNoticeClaimantName,
      counterNoticeTextRu: claim.counterNoticeTextRu,
      resolutionNotesRu: claim.resolutionNotesRu,
      resolvedByUserId: claim.resolvedByUserId,
      parentClaimId: claim.parentClaimId,
      createdByUserId: claim.createdByUserId,
      components: components.map((component) => this.mapComponent(component)),
      accessBlocks: blocks.map((block) => this.mapBlock(block)),
      attachments: attachments.map((attachment) => this.mapAttachment(attachment)),
      events: events.map((event) => this.mapEvent(event)),
    };
  }

  private mapComponent(component: RightsClaimComponentRecord): RightsClaimComponentDto {
    return {
      id: component.id,
      rightsClaimId: component.rightsClaimId,
      rightsComponentId: component.rightsComponentId,
      componentType: component.componentType,
      titleRu: component.titleRu,
      notesRu: component.notesRu,
      createdAt: component.createdAt.toISOString(),
    };
  }

  private mapBlock(
    block: RightsClaimAccessBlockRecord,
    at: Date = new Date(),
  ): RightsClaimAccessBlockDto {
    const expired =
      block.status === RightsClaimBlockStatus.ACTIVE &&
      block.expiresAt !== null &&
      block.expiresAt.getTime() <= at.getTime();

    return {
      id: block.id,
      rightsClaimId: block.rightsClaimId,
      bookId: block.bookId,
      bookVersionId: block.bookVersionId,
      scope: block.scope,
      countryCode: block.countryCode,
      status: block.status,
      effectiveStatus: expired ? RightsClaimBlockStatus.EXPIRED : block.status,
      reasonRu: block.reasonRu,
      appliedAt: block.appliedAt.toISOString(),
      appliedByUserId: block.appliedByUserId,
      expiresAt: this.toIso(block.expiresAt),
      liftedAt: this.toIso(block.liftedAt),
      liftedByUserId: block.liftedByUserId,
      liftReasonRu: block.liftReasonRu,
      createdAt: block.createdAt.toISOString(),
    };
  }

  private mapAttachment(attachment: RightsClaimAttachmentRecord): RightsClaimAttachmentDto {
    return {
      id: attachment.id,
      rightsClaimId: attachment.rightsClaimId,
      attachmentType: attachment.attachmentType,
      title: attachment.title,
      fileName: attachment.fileName,
      mediaAssetId: attachment.mediaAssetId,
      storageKey: attachment.storageKey,
      url: attachment.url,
      sha256: attachment.sha256,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
      notesRu: attachment.notesRu,
      uploadedByUserId: attachment.uploadedByUserId,
      createdAt: attachment.createdAt.toISOString(),
    };
  }

  private mapEvent(event: RightsClaimEventRecord): RightsClaimEventDto {
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

  private toIso(value: Date | null): string | null {
    return value ? value.toISOString() : null;
  }
}
