import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsNotificationsService } from './rights-notifications.service';

/**
 * WP-6.3 (R9-02) — модуль-лист: зависит только от `PrismaService` и не импортирует ничего
 * из системы прав.
 *
 * До него уведомления жили внутри `RightsAgentModule`, а тот импортирует `RightsIntakeModule`,
 * поэтому ядро не могло писать уведомления без цикла модулей — отсюда асимметрия, где
 * агентский канал диагностировал сбой материализации, а ручной `POST /materialize` отдавал
 * голый 500. Файлы уведомлений остались в каталоге `rights-agent` (это по-прежнему фаза 17),
 * вынесен только модуль.
 *
 * **Импортировать ничего не должен** — любой импорт вернёт цикл, ради которого модуль и создан.
 */
@Module({
  providers: [RightsNotificationsService, PrismaService],
  exports: [RightsNotificationsService],
})
export class RightsNotificationsModule {}
