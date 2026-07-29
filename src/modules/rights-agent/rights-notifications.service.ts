import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AGENT_ERROR_CODES } from './rights-agent.constants';
import { agentError } from './rights-agent.errors';
import {
  RightsNotificationSeverity,
  type AgentDatabaseClient,
  type RightsNotificationDelegate,
  type RightsNotificationRecord,
  type RightsNotificationType,
} from './rights-agent-interface';
import type { ListRightsNotificationsDto } from './dto/list-rights-notifications.dto';
import type {
  RightsNotificationDto,
  RightsNotificationsListResponseDto,
} from './dto/rights-notification-response.dto';

export interface CreateRightsNotificationInput {
  type: RightsNotificationType;
  severity?: RightsNotificationSeverity;
  titleRu: string;
  messageRu: string;
  targetUserId?: string | null;
  rightsIntakeId?: string | null;
  agentSubmissionId?: string | null;
  rightsReviewImportId?: string | null;
  rightsProfileId?: string | null;
  bookVersionId?: string | null;
  payload?: Record<string, unknown> | null;
}

const MAX_LIMIT = 100;

/**
 * In-app notifications for editors. Phase 17 deliberately has no email/push channel —
 * a notification is a database row plus the admin UI that renders it.
 * Notifications are never deleted, only marked as read.
 */
@Injectable()
export class RightsNotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  private get delegate(): RightsNotificationDelegate {
    return (this.prisma as unknown as Record<string, unknown>)[
      'rightsNotification'
    ] as RightsNotificationDelegate;
  }

  /** `targetUserId: null` marks a broadcast visible to every admin / content manager. */
  async create(
    input: CreateRightsNotificationInput,
    tx?: AgentDatabaseClient,
  ): Promise<RightsNotificationRecord> {
    const delegate = tx ? tx.rightsNotification : this.delegate;
    return delegate.create({
      data: {
        type: input.type,
        severity: input.severity ?? RightsNotificationSeverity.INFO,
        titleRu: input.titleRu,
        messageRu: input.messageRu,
        targetUserId: input.targetUserId ?? null,
        rightsIntakeId: input.rightsIntakeId ?? null,
        agentSubmissionId: input.agentSubmissionId ?? null,
        rightsReviewImportId: input.rightsReviewImportId ?? null,
        rightsProfileId: input.rightsProfileId ?? null,
        bookVersionId: input.bookVersionId ?? null,
        payload: input.payload ?? undefined,
      },
    });
  }

  async list(
    userId: string,
    query: ListRightsNotificationsDto,
  ): Promise<RightsNotificationsListResponseDto> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, MAX_LIMIT) : 20;
    const skip = (page - 1) * limit;

    const where = this.buildWhere(userId, query);

    const [total, items] = await Promise.all([
      this.delegate.count({ where }),
      this.delegate.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    ]);

    return { items: items.map((item) => this.toDto(item)), total, page, limit };
  }

  async unreadCount(userId: string): Promise<{ unreadCount: number }> {
    const unreadCount = await this.delegate.count({
      where: { ...this.visibilityWhere(userId), isRead: false },
    });
    return { unreadCount };
  }

  /** Idempotent: marking an already-read notification does not move `readAt`. */
  async markRead(id: string, userId: string): Promise<RightsNotificationDto> {
    const existing = await this.delegate.findUnique({ where: { id } });
    if (!existing || (existing.targetUserId !== null && existing.targetUserId !== userId)) {
      throw agentError(HttpStatus.NOT_FOUND, AGENT_ERROR_CODES.NOTIFICATION_NOT_FOUND);
    }

    if (existing.isRead) {
      return this.toDto(existing);
    }

    const updated = await this.delegate.update({
      where: { id },
      data: { isRead: true, readAt: new Date(), readByUserId: userId },
    });
    return this.toDto(updated);
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const result = await this.delegate.updateMany({
      where: { ...this.visibilityWhere(userId), isRead: false },
      data: { isRead: true, readAt: new Date(), readByUserId: userId },
    });
    return { updated: result.count };
  }

  /** Broadcasts plus notifications addressed to this user; never someone else's. */
  private visibilityWhere(userId: string): Record<string, unknown> {
    return { OR: [{ targetUserId: null }, { targetUserId: userId }] };
  }

  private buildWhere(userId: string, query: ListRightsNotificationsDto): Record<string, unknown> {
    const where: Record<string, unknown> = this.visibilityWhere(userId);
    if (query.unreadOnly) {
      where['isRead'] = false;
    }
    if (query.type) {
      where['type'] = query.type;
    }
    if (query.severity) {
      where['severity'] = query.severity;
    }
    if (query.rightsIntakeId) {
      where['rightsIntakeId'] = query.rightsIntakeId;
    }
    return where;
  }

  private toDto(record: RightsNotificationRecord): RightsNotificationDto {
    return {
      id: record.id,
      type: record.type,
      severity: record.severity,
      titleRu: record.titleRu,
      messageRu: record.messageRu,
      rightsIntakeId: record.rightsIntakeId,
      agentSubmissionId: record.agentSubmissionId,
      rightsReviewImportId: record.rightsReviewImportId,
      rightsProfileId: record.rightsProfileId,
      bookVersionId: record.bookVersionId,
      payload: (record.payload as Record<string, unknown> | null) ?? null,
      isRead: record.isRead,
      readAt: record.readAt ? new Date(record.readAt).toISOString() : null,
      createdAt: new Date(record.createdAt).toISOString(),
    };
  }
}
