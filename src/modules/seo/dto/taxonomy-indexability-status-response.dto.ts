import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 * Зеркалит `TaxonomySweepStatus`
 * (`src/modules/seo/indexability/taxonomy-indexability-scheduler.service.ts`).
 */
export class TaxonomyIndexabilityStatusResponseDto {
  @ApiProperty()
  enabled!: boolean;

  @ApiProperty({ description: 'Wall-clock hour (UTC) the sweep is pinned to.' })
  scheduledHourUtc!: number;

  @ApiProperty({ type: String, nullable: true })
  nextRunAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  lastStartedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  lastFinishedAt!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  lastDurationMs!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  lastScanned!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  lastChanged!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  lastOpened!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  lastClosed!: number | null;

  @ApiProperty({ type: String, nullable: true })
  lastError!: string | null;

  @ApiProperty()
  isRunning!: boolean;
}
