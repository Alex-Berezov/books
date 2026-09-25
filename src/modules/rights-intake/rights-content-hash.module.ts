import { Module } from '@nestjs/common';
import { RightsClearanceLockService } from './rights-clearance-lock.service';
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
 * Второй провайдер — `RightsClearanceLockService` (`LEGACY-368`): замок группы клиренса,
 * под которым главы, аудиоглавы и версии пишут строки и помечают stale, а пересчёт по персоне
 * и профилю прав запирает набор групп и строк версий (`runInLockedClearanceScope`). Живёт здесь же,
 * потому что зависит от того же и одного `PrismaService`.
 *
 * **Импортировать ничего не должен** — любой импорт вернёт цикл, ради которого модуль и создан.
 */
@Module({
  providers: [RightsContentHashService, RightsClearanceLockService],
  exports: [RightsContentHashService, RightsClearanceLockService],
})
export class RightsContentHashModule {}
