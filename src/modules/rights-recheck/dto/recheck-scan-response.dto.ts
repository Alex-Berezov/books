import { ApiProperty } from '@nestjs/swagger';
import { RightsRecheckScanStatus, RightsRecheckTriggerSource } from '../rights-recheck-interface';

export class RecheckScanRunDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: RightsRecheckScanStatus }) status!: RightsRecheckScanStatus;
  @ApiProperty({ enum: RightsRecheckTriggerSource }) source!: RightsRecheckTriggerSource;
  @ApiProperty() startedAt!: string;
  @ApiProperty({ nullable: true }) finishedAt!: string | null;
  @ApiProperty({ nullable: true }) durationMs!: number | null;
  @ApiProperty() profilesScanned!: number;
  @ApiProperty() versionsScanned!: number;
  @ApiProperty() tasksCreated!: number;
  @ApiProperty() tasksEscalated!: number;
  @ApiProperty() tasksAutoClosed!: number;
  @ApiProperty() remindersSent!: number;
  @ApiProperty({ nullable: true }) errorMessage!: string | null;
  @ApiProperty({ nullable: true }) triggeredByUserId!: string | null;
}

export class RecheckScanRunListResponseDto {
  @ApiProperty({ type: [RecheckScanRunDto] }) items!: RecheckScanRunDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
