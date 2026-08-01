import { ApiPropertyOptional } from '@nestjs/swagger';
import { RightsActionStatus } from '@prisma/client';
import { IsEnum, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * WP-5.2: изменение действия человеком. Действие предлагает агент — закрывает редактор,
 * поэтому статус здесь единственный способ его закрыть (`suggestedStatus` отчёта сужен
 * до `PENDING` / `IN_PROGRESS`, см. WP-5.3).
 *
 * `null` в `assignedToUserId` и `dueAt` означает «снять значение»; отсутствие поля —
 * «не трогать».
 */
export class UpdateRightsActionDto {
  @ApiPropertyOptional({ description: 'New action status', enum: RightsActionStatus })
  @IsOptional()
  @IsEnum(RightsActionStatus)
  status?: RightsActionStatus;

  @ApiPropertyOptional({
    description: 'Comment on the change. Mandatory when the status becomes WAIVED.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  completionNotesRu?: string;

  @ApiPropertyOptional({ description: 'Assignee user id, or null to unassign', nullable: true })
  @IsOptional()
  @IsUUID()
  assignedToUserId?: string | null;

  @ApiPropertyOptional({ description: 'Due date (ISO 8601), or null to clear', nullable: true })
  @IsOptional()
  @IsISO8601()
  dueAt?: string | null;
}
