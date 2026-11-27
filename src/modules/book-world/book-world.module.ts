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
import { WikidataClient } from './wikidata.client';
import { WorldGeoService } from './world-geo.service';
import { WorldMapService } from './world-map.service';
import { OsmTileClient } from './osm-tile.client';
import { StorageModule } from '../../shared/storage/storage.module';

/**
 * Мир книги (F08). `BookWorldService` экспортируется для хода «Write World» (`F08-4`);
 * `WorldMentionsService` — пересчёт присутствия по главам (`F08-2`), его зовёт планировщик модуля;
 * снаружи присутствие ставится в очередь (`markWorldMentionsDirty`), единственное исключение — ход
 * «Write World» пересчитывает версию сам перед новой парой, до первого успешного пересчёта (`recountVersion`, решение арбитра
 * `F08 | F08-8e-1` Q1: условие заведения пары читает сохранённое присутствие).
 * Чтение для читателя — только ручкой. `WorldSitemapService` — карта сайта мира (`F08-3`), её ручку
 * держит публичный контроллер `:lang`; счётчики страниц и отчёт — `WorldStatsController`.
 * `WorldMapService` — литературная карта (`F08-12d`): тайлы OSM по запросу страницы с картой.
 */
@Module({
  // Реестр глобальный; его импорт — для изолированной сборки модуля в тестах, как у остальных
  // таймеров. Хранилище — тайлы литературной карты (`WorldMapService`).
  imports: [BackgroundJobsRegistryModule, RateLimitModule, StorageModule],
  controllers: [BookWorldController, WorldStatsController],
  providers: [
    BookWorldService,
    WorldMentionsService,
    WorldMentionsSchedulerService,
    WorldSitemapService,
    WorldStatsService,
    WikidataClient,
    WorldGeoService,
    OsmTileClient,
    WorldMapService,
  ],
  exports: [BookWorldService, WorldMentionsService, WorldSitemapService],
})
export class BookWorldModule {}
