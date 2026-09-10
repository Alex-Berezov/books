import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 * Зеркалит `BackgroundJobStatus`/`BackgroundJobsRegistry.summary()`
 * (`src/modules/background-jobs/background-jobs.registry.ts`).
 */
export class BackgroundJobStatusDto {
  @ApiProperty({ description: 'Устойчивое имя механизма — оно же ключ в ответе эндпоинта.' })
  name!: string;

  @ApiProperty({ enum: ['ACTIVE', 'DEGRADED', 'DISABLED'] })
  state!: 'ACTIVE' | 'DEGRADED' | 'DISABLED';

  @ApiPropertyOptional({ description: 'Обязательна для DEGRADED и DISABLED.' })
  reason?: string;

  @ApiPropertyOptional({ description: 'Расписание для активных: «daily at 03:00 UTC».' })
  schedule?: string;

  @ApiProperty()
  purpose!: string;
}

export class BackgroundJobsCountsDto {
  @ApiProperty()
  ACTIVE!: number;

  @ApiProperty()
  DEGRADED!: number;

  @ApiProperty()
  DISABLED!: number;
}

export class BackgroundJobsStatusResponseDto {
  @ApiProperty()
  checkedAt!: string;

  @ApiProperty({ type: BackgroundJobsCountsDto })
  counts!: BackgroundJobsCountsDto;

  @ApiProperty({ type: BackgroundJobStatusDto, isArray: true })
  jobs!: BackgroundJobStatusDto[];
}
