import { ApiProperty } from '@nestjs/swagger';

/**
 * Ответ `POST /admin/media/probe` — постановка одного `MediaAsset` в очередь ffprobe.
 * Результат самой пробы здесь не возвращается: обработчик отвечает 202 сразу после
 * постановки задачи (`MediaProbeService.enqueueProbe`).
 */
export class ProbeResponseDto {
  @ApiProperty({ description: 'Всегда `true`: задача поставлена в очередь' })
  ok!: boolean;
}
