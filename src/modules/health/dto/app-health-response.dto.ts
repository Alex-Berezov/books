import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 * Зеркалит `AppController.getHealth()` (`src/app.controller.ts`) — тривиальный
 * машиночитаемый health-ответ корневого контроллера, отдельный от
 * `HealthController` (`/health/liveness`, `/health/readiness`).
 */
export class AppHealthResponseDto {
  @ApiProperty({ example: 'ok' })
  status!: string;

  @ApiProperty()
  uptime!: number;

  @ApiProperty()
  timestamp!: string;
}
