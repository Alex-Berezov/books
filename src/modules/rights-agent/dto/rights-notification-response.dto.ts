import { ApiProperty } from '@nestjs/swagger';
import { RightsNotificationSeverity, RightsNotificationType } from '../rights-agent-interface';

export class RightsNotificationDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: RightsNotificationType }) type!: RightsNotificationType;
  @ApiProperty({ enum: RightsNotificationSeverity }) severity!: RightsNotificationSeverity;
  @ApiProperty() titleRu!: string;
  @ApiProperty() messageRu!: string;
  @ApiProperty({ nullable: true }) rightsIntakeId!: string | null;
  @ApiProperty({ nullable: true }) agentSubmissionId!: string | null;
  @ApiProperty({ nullable: true }) rightsReviewImportId!: string | null;
  @ApiProperty({ nullable: true }) rightsProfileId!: string | null;
  @ApiProperty({ nullable: true }) bookVersionId!: string | null;
  @ApiProperty({ nullable: true, type: Object }) payload!: Record<string, unknown> | null;
  @ApiProperty() isRead!: boolean;
  @ApiProperty({ nullable: true }) readAt!: string | null;
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
