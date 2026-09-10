import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 * Зеркалит `AppController.getHealth()` (`src/app.controller.ts`) — тривиальный
 * машиночитаемый health-ответ корневого контроллера, отдельный от
 * `HealthController` (`/health/liveness`, `/health/readiness`).
 */
export class AppHealthResponseDto {
  @ApiProperty({ type: String, example: 'ok' })
  status!: string;

  @ApiProperty({ type: Number })
  uptime!: number;

  @ApiProperty({ type: String })
  timestamp!: string;
}
