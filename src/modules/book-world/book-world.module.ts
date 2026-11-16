import { Module } from '@nestjs/common';
import { BackgroundJobsRegistryModule } from '../background-jobs/background-jobs-registry.module';
import { BookWorldService } from './book-world.service';
import { BookWorldController } from './book-world.controller';
import { WorldMentionsService } from './world-mentions.service';
import { WorldMentionsSchedulerService } from './world-mentions-scheduler.service';
import { RateLimitModule } from '../../shared/rate-limit/rate-limit.module';
import { WorldSitemapService } from './world-sitemap.service';
import { WorldStatsService } from './world-stats.service';
import { WorldStatsController } from './world-stats.controller';

/**
 * Мир книги (F08). `BookWorldService` экспортируется для хода «Write World» (`F08-4`);
 * `WorldMentionsService` — пересчёт присутствия по главам (`F08-2`), его зовёт только планировщик
 * модуля: снаружи присутствие ставится в очередь (`markWorldMentionsDirty`), не считается.
 * Чтение для читателя — только ручкой. `WorldSitemapService` — карта сайта мира (`F08-3`), её ручку
 * держит публичный контроллер `:lang`; счётчики страниц и отчёт — `WorldStatsController`.
 */
@Module({
  // Реестр глобальный; импорт — для изолированной сборки модуля в тестах, как у остальных таймеров.
  imports: [BackgroundJobsRegistryModule, RateLimitModule],
  controllers: [BookWorldController, WorldStatsController],
  providers: [
    BookWorldService,
    WorldMentionsService,
    WorldMentionsSchedulerService,
    WorldSitemapService,
    WorldStatsService,
  ],
  exports: [BookWorldService, WorldSitemapService],
})
export class BookWorldModule {}
