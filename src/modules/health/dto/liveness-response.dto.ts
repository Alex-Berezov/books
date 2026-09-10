import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 * Зеркалит `LivenessResult` (`src/modules/health/health.service.ts`).
 */
export class LivenessResponseDto {
  @ApiProperty({ enum: ['up', 'down'] })
  status!: 'up' | 'down';

  @ApiProperty()
  uptime!: number;

  @ApiProperty()
  timestamp!: string;

  @ApiProperty({
    description:
      'Тег образа, с которым был запущен контейнер; "unknown", если деплой его не передал.',
  })
  version!: string;
}
