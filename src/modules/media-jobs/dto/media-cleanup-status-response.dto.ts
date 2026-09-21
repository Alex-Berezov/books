import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 * Зеркалит `MediaCleanupSweepStatus`
 * (`src/modules/media-jobs/media-cleanup-scheduler.service.ts`).
 */
export class MediaCleanupStatusResponseDto {
  @ApiProperty({ type: Boolean })
  enabled!: boolean;

  @ApiProperty({ type: Number, description: 'Wall-clock hour (UTC) the sweep is pinned to.' })
  scheduledHourUtc!: number;

  @ApiProperty({ type: String, nullable: true })
  nextRunAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  lastStartedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  lastFinishedAt!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  lastDurationMs!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'How many assets the sweep looked at. Without it "deleted 0" is indistinguishable from a sweep that scanned nothing.',
  })
  lastScanned!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  lastSkippedByUrlReference!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  lastMarkedSoftDeleted!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  lastHardDeleted!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  lastStorageFilesRemoved!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  lastStorageErrors!: number | null;

  @ApiProperty({ type: String, nullable: true })
  lastError!: string | null;

  @ApiProperty({ type: Boolean })
  isRunning!: boolean;
}
