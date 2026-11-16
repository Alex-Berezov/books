import { Module } from '@nestjs/common';
import { BackgroundJobsRegistryModule } from '../background-jobs/background-jobs-registry.module';
import { BookWorldService } from './book-world.service';
import { BookWorldController } from './book-world.controller';
import { WorldMentionsService } from './world-mentions.service';
import { WorldMentionsSchedulerService } from './world-mentions-scheduler.service';

/**
 * Мир книги (F08). `BookWorldService` экспортируется для хода «Write World» (`F08-4`);
 * `WorldMentionsService` — пересчёт присутствия по главам (`F08-2`), его зовёт только планировщик
 * модуля: снаружи присутствие ставится в очередь (`markWorldMentionsDirty`), не считается.
 * Чтение для читателя — только ручкой.
 */
@Module({
  // Реестр глобальный; импорт — для изолированной сборки модуля в тестах, как у остальных таймеров.
  imports: [BackgroundJobsRegistryModule],
  controllers: [BookWorldController],
  providers: [BookWorldService, WorldMentionsService, WorldMentionsSchedulerService],
  exports: [BookWorldService],
})
export class BookWorldModule {}
