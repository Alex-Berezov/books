import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsContentHashService } from './rights-content-hash.service';

/**
 * WP-8.1 (R1-01) — модуль-лист: зависит только от `PrismaService`.
 *
 * Хеш-сервис жил внутри `RightsIntakeModule`, а тот импортирует `PersonsModule`, поэтому
 * из путей работы с персонами и участниками пометить клиренс устаревшим было нельзя —
 * получался цикл модулей. Файлы остались в каталоге `rights-intake` (это по-прежнему фаза 8),
 * вынесен только модуль; `RightsIntakeModule` реэкспортирует его целиком, поэтому
 * потребители, импортирующие интейк, не изменились.
 *
 * **Импортировать ничего не должен** — любой импорт вернёт цикл, ради которого модуль и создан.
 */
@Module({
  providers: [RightsContentHashService, PrismaService],
  exports: [RightsContentHashService],
})
export class RightsContentHashModule {}
