import { Module } from '@nestjs/common';
import { BackgroundJobsRegistryModule } from './background-jobs-registry.module';
import { BackgroundJobsController } from './background-jobs.controller';
import { BackgroundJobsService } from './background-jobs.service';

/**
 * Наблюдаемая часть инвентаря: печать при старте и `GET /admin/background-jobs`.
 *
 * Регистрируется только в корневом модуле. Сам реестр живёт отдельно
 * (`BackgroundJobsRegistryModule`) — см. комментарий там, почему.
 */
@Module({
  imports: [BackgroundJobsRegistryModule],
  controllers: [BackgroundJobsController],
  providers: [BackgroundJobsService],
})
export class BackgroundJobsModule {}
