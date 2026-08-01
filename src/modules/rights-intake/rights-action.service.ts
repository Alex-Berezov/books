import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsMaterializationService } from './rights-materialization.service';
import {
  ACTION_STATUS_TRANSITIONS,
  COMPONENT_REMOVAL_ACTION_TYPES,
  RESOLVED_ACTION_STATUSES,
} from './rights-action.constants';
import { mapRightsAction } from './rights-action.mapper';
import type { UpdateRightsActionDto } from './dto/update-rights-action.dto';
import type { RightsActionDto } from './dto/rights-profile-response.dto';

const isResolvedStatus = (status: string): boolean =>
  (RESOLVED_ACTION_STATUSES as readonly string[]).includes(status);

const isRemovalActionType = (actionType: string): boolean =>
  (COMPONENT_REMOVAL_ACTION_TYPES as readonly string[]).includes(actionType);

/**
 * WP-5.2 — человеческий цикл закрытия обязательного действия.
 *
 * До этого сервиса `RightsAction.status` писался единственный раз при материализации отчёта:
 * блокирующее действие мог закрыть только агент своим отчётом, а редактор — никогда, из-за
 * чего интейк с таким действием было невозможно ни утвердить, ни превратить в книгу (R3-02).
 *
 * Проверка блокирующих действий в approve, создании книги и блоке гейта 6.12 не ослабляется —
 * добавляется недостающая половина: способ закрыть действие человеком, с автором и следом
 * в аудите.
 */
@Injectable()
export class RightsActionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly materializationService: RightsMaterializationService,
  ) {}

  private get actions() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsAction'] as {
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
  }

  async getById(actionId: string): Promise<RightsActionDto> {
    const action = await this.actions.findUnique({ where: { id: actionId } });
    if (!action) throw new NotFoundException(`Rights action ${actionId} not found`);
    return mapRightsAction(action);
  }

  async update(
    actionId: string,
    dto: UpdateRightsActionDto,
    userId: string | null,
  ): Promise<RightsActionDto> {
    const action = await this.actions.findUnique({ where: { id: actionId } });
    if (!action) throw new NotFoundException(`Rights action ${actionId} not found`);

    const currentStatus = action['status'] as string;
    const nextStatus = dto.status ?? currentStatus;
    const statusChanged = nextStatus !== currentStatus;

    if (statusChanged) {
      const allowed = ACTION_STATUS_TRANSITIONS[currentStatus] ?? [];
      if (!allowed.includes(nextStatus)) {
        throw new BadRequestException(
          `Cannot change rights action status from ${currentStatus} to ${nextStatus}`,
        );
      }
    }

    const notes = dto.completionNotesRu?.trim();
    // Отказ от обязательного действия — решение, а не отметка: без объяснения оно
    // неотличимо от «забыли сделать».
    if (statusChanged && nextStatus === 'WAIVED' && !notes) {
      throw new BadRequestException('completionNotesRu is required when waiving a rights action');
    }

    const assigneeProvided = dto.assignedToUserId !== undefined;
    if (assigneeProvided && dto.assignedToUserId) {
      const assignee = await this.prisma.user.findUnique({
        where: { id: dto.assignedToUserId },
        select: { id: true },
      });
      if (!assignee) {
        throw new BadRequestException(`User ${dto.assignedToUserId} not found`);
      }
    }

    const dueProvided = dto.dueAt !== undefined;
    const nextDueAt = dueProvided && dto.dueAt ? new Date(dto.dueAt) : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      const t = tx as unknown as Record<string, unknown>;
      const actionTx = t['rightsAction'] as {
        update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      const eventTx = t['rightsActionEvent'] as {
        create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };

      const data: Record<string, unknown> = {};

      if (statusChanged) {
        data['status'] = nextStatus;
        if (isResolvedStatus(nextStatus)) {
          data['completedAt'] = new Date();
          data['completedByUserId'] = userId;
        } else if (isResolvedStatus(currentStatus)) {
          // Действие снова открыто — снимок закрытия перестаёт быть правдой. Сам факт
          // прежнего закрытия остаётся в событиях, поэтому след не теряется.
          data['completedAt'] = null;
          data['completedByUserId'] = null;
        }
      }
      if (notes !== undefined) data['completionNotesRu'] = notes || null;
      if (assigneeProvided) data['assignedToUserId'] = dto.assignedToUserId ?? null;
      if (dueProvided) data['dueAt'] = nextDueAt;

      const record = await actionTx.update({ where: { id: actionId }, data });

      // Событие пишется в той же транзакции, что и изменение (ADR-009): смена статуса
      // без следа в аудите — ровно то, чем был отчёт агента, закрывающий своё действие.
      if (statusChanged) {
        await eventTx.create({
          data: {
            rightsActionId: actionId,
            eventType: 'STATUS_CHANGED',
            fromStatus: currentStatus,
            toStatus: nextStatus,
            notesRu: notes ?? null,
            createdByUserId: userId,
          },
        });
      } else if (notes) {
        await eventTx.create({
          data: {
            rightsActionId: actionId,
            eventType: 'NOTE_ADDED',
            notesRu: notes,
            createdByUserId: userId,
          },
        });
      }

      if (
        assigneeProvided &&
        (action['assignedToUserId'] ?? null) !== (dto.assignedToUserId ?? null)
      ) {
        await eventTx.create({
          data: {
            rightsActionId: actionId,
            eventType: dto.assignedToUserId ? 'ASSIGNED' : 'UNASSIGNED',
            payload: { assignedToUserId: dto.assignedToUserId ?? null },
            createdByUserId: userId,
          },
        });
      }

      if (dueProvided) {
        await eventTx.create({
          data: {
            rightsActionId: actionId,
            eventType: 'DUE_DATE_CHANGED',
            payload: { dueAt: nextDueAt ? nextDueAt.toISOString() : null },
            createdByUserId: userId,
          },
        });
      }

      // WP-5.5: закрытие действия на удаление компонента — единственное подтверждение того,
      // что компонент действительно убран из издания, поэтому вердикты по странам
      // пересчитываются здесь же, в одной транзакции со сменой статуса.
      if (statusChanged && isRemovalActionType(action['actionType'] as string)) {
        const recomputed =
          (await this.materializationService.recomputeTerritoryDecisionsFromComponents(
            t,
            action['rightsProfileId'] as string,
          )) as { changedCountryCodes: string[] } | null;
        if (recomputed && recomputed.changedCountryCodes.length > 0) {
          await eventTx.create({
            data: {
              rightsActionId: actionId,
              eventType: 'NOTE_ADDED',
              notesRu: `Пересчитаны решения по странам: ${recomputed.changedCountryCodes.join(', ')}.`,
              payload: { recomputedCountryCodes: recomputed.changedCountryCodes },
              createdByUserId: userId,
            },
          });
        }
      }

      return record;
    });

    return mapRightsAction(updated);
  }
}
