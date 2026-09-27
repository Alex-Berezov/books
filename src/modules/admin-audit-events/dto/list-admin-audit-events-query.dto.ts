import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDefined,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsUUID,
  Matches,
  ValidateIf,
} from 'class-validator';
import { AdminAuditAction, AdminAuditTargetType } from '@prisma/client';
import { ChildListQueryDto } from '../../../shared/dto/child-list-query.dto';

/**
 * Граница окна — дата-время с зоной. Дата без времени (`2026-09-27`) читалась бы полуночью UTC,
 * и `to=<сегодня>` молча отрезал бы весь день; время без зоны — поясом сервера. Несуществующую
 * дату (`02-30`, год `0000`) отсекает строгий `IsISO8601`: `new Date()` перенёс бы её в март.
 */
const ISO_DATE_TIME_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const DATE_TIME_MESSAGE =
  '$property must be an ISO date-time with a time zone (e.g. 2026-09-27T00:00:00Z)';

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
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(ISO_DATE_TIME_WITH_ZONE, { message: DATE_TIME_MESSAGE })
  from?: string;

  @ApiPropertyOptional({
    description:
      'ISO date-time with a time zone, inclusive upper bound of createdAt; earlier than from gives 400',
  })
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(ISO_DATE_TIME_WITH_ZONE, { message: DATE_TIME_MESSAGE })
  to?: string;
}
