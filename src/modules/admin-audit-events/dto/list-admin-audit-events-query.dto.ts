import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDefined, IsEnum, IsOptional, IsUUID, ValidateIf } from 'class-validator';
import { AdminAuditAction, AdminAuditTargetType } from '@prisma/client';
import { ChildListQueryDto } from '../../../shared/dto/child-list-query.dto';
import { IsIsoDateTimeWithZone } from '../../../shared/validators/iso-date-time-with-zone.decorator';

/**
 * Параметры `GET /admin/audit-events` (`LEGACY-015` пункт 3, решение арбитра 27.09.2026).
 *
 * ⚠️ `targetId` без `targetType` — 400, а не выборка по одному идентификатору: в колонке
 * лежат идентификаторы разных сущностей, и запрос без типа уходит мимо составного индекса
 * `[targetType, targetId, createdAt]`. Страница (`page`, `limit` 20 по умолчанию, потолок 100)
 * — общая для админских списков, из `ChildListQueryDto`; здесь только фильтры.
 */
export class ListAdminAuditEventsQueryDto extends ChildListQueryDto {
  @ApiPropertyOptional({
    enum: AdminAuditTargetType,
    enumName: 'AdminAuditTargetType',
    description: 'Required when targetId is set',
  })
  @ValidateIf(
    (o: ListAdminAuditEventsQueryDto) => o.targetType !== undefined || o.targetId !== undefined,
  )
  @IsDefined({ message: 'targetType is required when targetId is set' })
  @IsEnum(AdminAuditTargetType)
  targetType?: AdminAuditTargetType;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  targetId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @ApiPropertyOptional({ enum: AdminAuditAction, enumName: 'AdminAuditAction' })
  @IsOptional()
  @IsEnum(AdminAuditAction)
  action?: AdminAuditAction;

  @ApiPropertyOptional({
    description: 'ISO date-time with a time zone, inclusive lower bound of createdAt',
  })
  @IsOptional()
  @IsIsoDateTimeWithZone()
  from?: string;

  @ApiPropertyOptional({
    description:
      'ISO date-time with a time zone, inclusive upper bound of createdAt; earlier than from gives 400',
  })
  @IsOptional()
  @IsIsoDateTimeWithZone()
  to?: string;
}
