import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 * Зеркалит `ReadinessCheckResult` (`src/modules/health/health.service.ts`).
 */
export class ReadinessDetailsDto {
  @ApiProperty({ enum: ['up', 'down'] })
  prisma!: 'up' | 'down';

  @ApiPropertyOptional({ enum: ['up', 'down', 'skipped'] })
  redis?: 'up' | 'down' | 'skipped';
}

export class ReadinessResponseDto {
  @ApiProperty({ enum: ['up', 'down'] })
  status!: 'up' | 'down';

  @ApiProperty({ type: ReadinessDetailsDto })
  details!: ReadinessDetailsDto;
}
