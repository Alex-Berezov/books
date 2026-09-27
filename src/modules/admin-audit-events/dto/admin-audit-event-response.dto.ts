import { ApiProperty } from '@nestjs/swagger';
import { AdminAuditAction, AdminAuditTargetType } from '@prisma/client';

/**
 * Строка журнала как есть. Почты и имени актёра здесь нет намеренно: инвариант
 * докблока модели `AdminAuditEvent` — журнал не место для персональных данных,
 * актёр сопоставляется через `GET /users/:id` (решение арбитра 27.09.2026).
 */
export class AdminAuditEventResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'null when the action had no human actor (env bootstrap on registration)',
  })
  actorUserId!: string | null;

  @ApiProperty({ enum: AdminAuditAction, enumName: 'AdminAuditAction' })
  action!: AdminAuditAction;

  @ApiProperty({ enum: AdminAuditTargetType, enumName: 'AdminAuditTargetType' })
  targetType!: AdminAuditTargetType;

  @ApiProperty({ format: 'uuid' })
  targetId!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description:
      'Event-specific object; never carries emails or names of users. AUTHOR_DELETED lists public {language, slug} addresses of the deleted author.',
  })
  payload!: Record<string, unknown> | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}
