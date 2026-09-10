import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 * Зеркалит `QueueService.status()` (`src/modules/queue/queue.service.ts`):
 * `{ enabled: boolean }` — тривиальный ответ, лишних полей у него нет.
 */
export class QueueStatusResponseDto {
  @ApiProperty({ description: 'Есть ли конфигурация Redis для очередей.' })
  enabled!: boolean;
}
