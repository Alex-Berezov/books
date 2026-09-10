import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 * Зеркалит `BackgroundJobStatus`/`BackgroundJobsRegistry.summary()`
 * (`src/modules/background-jobs/background-jobs.registry.ts`).
 */
export class BackgroundJobStatusDto {
  @ApiProperty({
    type: String,
    description: 'Устойчивое имя механизма — оно же ключ в ответе эндпоинта.',
  })
  name!: string;

  @ApiProperty({ enum: ['ACTIVE', 'DEGRADED', 'DISABLED'] })
  state!: 'ACTIVE' | 'DEGRADED' | 'DISABLED';

  @ApiPropertyOptional({ type: String, description: 'Обязательна для DEGRADED и DISABLED.' })
  reason?: string;

  @ApiPropertyOptional({
    type: String,
    description: 'Расписание для активных: «daily at 03:00 UTC».',
  })
  schedule?: string;

  @ApiProperty({ type: String })
  purpose!: string;
}

export class BackgroundJobsCountsDto {
  @ApiProperty({ type: Number })
  ACTIVE!: number;

  @ApiProperty({ type: Number })
  DEGRADED!: number;

  @ApiProperty({ type: Number })
  DISABLED!: number;
}

export class BackgroundJobsStatusResponseDto {
  @ApiProperty({ type: String })
  checkedAt!: string;

  @ApiProperty({ type: BackgroundJobsCountsDto })
  counts!: BackgroundJobsCountsDto;

  @ApiProperty({ type: BackgroundJobStatusDto, isArray: true })
  jobs!: BackgroundJobStatusDto[];
}
