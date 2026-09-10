import { ApiProperty } from '@nestjs/swagger';
import { RightsNotificationSeverity, RightsNotificationType } from '../rights-agent-interface';

export class RightsNotificationDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: RightsNotificationType }) type!: RightsNotificationType;
  @ApiProperty({ enum: RightsNotificationSeverity }) severity!: RightsNotificationSeverity;
  @ApiProperty() titleRu!: string;
  @ApiProperty() messageRu!: string;
  @ApiProperty({ type: String, nullable: true }) rightsIntakeId!: string | null;
  @ApiProperty({ type: String, nullable: true }) agentSubmissionId!: string | null;
  @ApiProperty({ type: String, nullable: true }) rightsReviewImportId!: string | null;
  @ApiProperty({ type: String, nullable: true }) rightsProfileId!: string | null;
  @ApiProperty({ type: String, nullable: true }) bookVersionId!: string | null;
  @ApiProperty({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description:
      'Free-form by design: every notification type writes its own keys (`RightsNotificationsService.create` takes `payload: unknown`; callers pass `{ tokenPrefix, maxUses, expiresAt }`, `{ warningCount }`, `{ lawyerReviewId, reviewNumber }`, `{ recheckTaskId, stage }` and so on). No validation constrains the composition.',
  })
  payload!: Record<string, unknown> | null;
  @ApiProperty() isRead!: boolean;
  @ApiProperty({ type: String, nullable: true }) readAt!: string | null;
  @ApiProperty() createdAt!: string;
}

export class RightsNotificationsListResponseDto {
  @ApiProperty({ type: [RightsNotificationDto] }) items!: RightsNotificationDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

export class RightsNotificationsUnreadCountDto {
  @ApiProperty() unreadCount!: number;
}

export class RightsNotificationsMarkAllReadDto {
  @ApiProperty() updated!: number;
}
