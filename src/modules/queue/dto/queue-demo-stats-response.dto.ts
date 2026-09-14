import { ApiProperty } from '@nestjs/swagger';

/**
 * Ответ `GET /queues/demo/stats` — счётчики задач демонстрационной очереди BullMQ.
 *
 * Шесть полей приходят всегда, включая ветку «Redis не настроен»: до 14.09.2026 она отдавала
 * пустой объект, и тип возврата был `Record<string, number>` — непрозрачный для сторожа схемы
 * ответа, из-за чего маршрут висел в вердикте `unverifiable` (`LEGACY-016`). Нули вместо
 * пустоты ничего не скрывают: подключена ли подсистема, отвечает соседний `GET /queues/status`.
 */
export class QueueDemoStatsResponseDto {
  @ApiProperty({ type: Number, description: 'Задачи, ожидающие исполнителя' })
  waiting!: number;

  @ApiProperty({ type: Number, description: 'Задачи в работе' })
  active!: number;

  @ApiProperty({ type: Number, description: 'Успешно завершённые задачи' })
  completed!: number;

  @ApiProperty({ type: Number, description: 'Задачи, упавшие после всех попыток' })
  failed!: number;

  @ApiProperty({ type: Number, description: 'Задачи, отложенные до срока' })
  delayed!: number;

  @ApiProperty({ type: Number, description: 'Задачи в приостановленной очереди' })
  paused!: number;
}
