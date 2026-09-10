import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 * Зеркалит `QueueService.enqueueDemo()` (`src/modules/queue/queue.service.ts`):
 * `{ id: string | undefined }` — id задачи BullMQ, если очередь включена.
 */
export class EnqueueDemoResponseDto {
  @ApiPropertyOptional()
  id?: string;
}
