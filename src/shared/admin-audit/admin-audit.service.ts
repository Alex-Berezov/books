import { Injectable } from '@nestjs/common';
import { AdminAuditAction, AdminAuditTargetType, Prisma } from '@prisma/client';

/**
 * Общий писатель журнала административных действий (`LEGACY-015`, дополнение к правилу:
 * новый модуль-писатель не копирует `adminAuditEvent.*` по месту, а ходит сюда).
 *
 * ⚠️ `tx` — первый **обязательный** параметр, а не необязательный с запасным вариантом:
 * забыть его нельзя, вызов без клиента не компилируется. Но подменить его корневым
 * `PrismaService` компилятор позволит — `Prisma.TransactionClient` это
 * `Omit<PrismaClient, ITXClientDenyList>`, и наследник `PrismaClient` ему структурно
 * подходит. Запись, пережившая откат своей операции, — это `LEGACY-036`, и от неё здесь
 * держит не тип, а посадка на каждом пути записи плюс сторож перечня писателей
 * (`src/common/testing/admin-audit-writers.spec.ts`).
 *
 * ⚠️ Форму `payload` сервис **не** унифицирует: у события смены роли она своя
 * (`{ role }`), у снятия версии с публикации — снимок лицензий. Общее здесь одно
 * и оно жёсткое: ни почты, ни имени — журнал выката и выгрузку базы читает кто угодно
 * (инвариант из doc-комментария модели `AdminAuditEvent`).
 */
@Injectable()
export class AdminAuditService {
  async record(
    tx: Prisma.TransactionClient,
    event: {
      action: AdminAuditAction;
      targetType: AdminAuditTargetType;
      targetId: string;
      actorUserId: string | null;
      payload?: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await tx.adminAuditEvent.create({
      data: {
        actorUserId: event.actorUserId,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId,
        ...(event.payload === undefined ? {} : { payload: event.payload }),
      },
    });
  }
}
