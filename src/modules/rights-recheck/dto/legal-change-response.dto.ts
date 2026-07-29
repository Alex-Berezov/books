import { ApiProperty } from '@nestjs/swagger';
import {
  RightsLegalChangeStatus,
  RightsLegalChangeType,
  RightsRecheckSeverity,
} from '../rights-recheck-interface';
import { RecheckTaskDto } from './recheck-task-response.dto';

export class LegalChangeDto {
  @ApiProperty() id!: string;
  @ApiProperty() titleRu!: string;
  @ApiProperty() descriptionRu!: string;
  @ApiProperty({ enum: RightsLegalChangeType }) changeType!: RightsLegalChangeType;
  @ApiProperty({ enum: RightsLegalChangeStatus }) status!: RightsLegalChangeStatus;
  @ApiProperty({ enum: RightsRecheckSeverity }) severity!: RightsRecheckSeverity;
  @ApiProperty({ type: [String] }) jurisdictionCodes!: string[];
  @ApiProperty() appliesToAllCountries!: boolean;
  @ApiProperty({ nullable: true }) effectiveFrom!: string | null;
  @ApiProperty({ nullable: true }) sourceUrl!: string | null;
  @ApiProperty({ nullable: true }) sourceTitle!: string | null;
  @ApiProperty({ nullable: true }) appliedAt!: string | null;
  @ApiProperty({ nullable: true }) appliedByUserId!: string | null;
  @ApiProperty() affectedProfilesCount!: number;
  @ApiProperty() createdTasksCount!: number;
  @ApiProperty({ nullable: true }) archivedAt!: string | null;
  @ApiProperty({ nullable: true }) createdByUserId!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class LegalChangeDetailDto extends LegalChangeDto {
  @ApiProperty({ type: [RecheckTaskDto] }) tasks!: RecheckTaskDto[];
  @ApiProperty() tasksCount!: number;
}

export class LegalChangeListResponseDto {
  @ApiProperty({ type: [LegalChangeDto] }) items!: LegalChangeDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
