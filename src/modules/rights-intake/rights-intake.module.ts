import { Module } from '@nestjs/common';
import { RightsIntakeService } from './rights-intake.service';
import { RightsIntakeManifestService } from './rights-intake-manifest.service';
import { RightsApprovalService } from './rights-approval.service';
import { RightsBookCreationService } from './rights-book-creation.service';
import { RightsReviewImportService } from './rights-review-import.service';
import { RightsReviewImportController } from './rights-review-import.controller';
import { RightsReviewImportValidator } from './rights-review-import.validator';
import { RightsIntakeController } from './rights-intake.controller';
import { RightsProfileController } from './rights-profile.controller';
import { RightsActionController } from './rights-action.controller';
import { RightsActionService } from './rights-action.service';
import { RightsMaterializationService } from './rights-materialization.service';
import { RightsProfileService } from './rights-profile.service';
import { RightsFilesController } from './rights-files.controller';
import { RightsFilesService } from './rights-files.service';
import { RightsContentHashModule } from './rights-content-hash.module';
import { RightsFileStorageModule } from '../../shared/rights-file-storage/rights-file-storage.module';
import { TerritoryRegionAggregationService } from './territory-region-aggregation.service';
import { ComponentTerritoryAggregationService } from './component-territory-aggregation.service';
import { PersonsModule } from '../persons/persons.module';
import { RightsNotificationsModule } from '../rights-agent/rights-notifications.module';
import { RightsLicensesModule } from '../rights-licenses/rights-licenses.module';
import { AuthorModule } from '../author/author.module';

/**
 * `RightsNotificationsModule` — лист графа (WP-6.3): импортировать сам `RightsAgentModule`
 * отсюда нельзя, он импортирует этот модуль.
 *
 * `RightsContentHashModule` — лист графа (WP-8.1): вынесен, чтобы пути персон и участников
 * могли помечать клиренс устаревшим (этот модуль импортирует `PersonsModule`, обратный
 * импорт был бы циклом). Реэкспортируется целиком — потребители не изменились.
 *
 * `RightsFileStorageModule` — лист графа (WP-9): приватное хранилище юридических файлов,
 * отдельное от публичного `StorageModule` медиа. Зависимостей на прикладные модули не имеет.
 *
 * `AuthorModule` — лист графа (LEGACY-006): из прикладных модулей не импортирует ничего
 * (только глобальный `SlugRedirectModule`, и тот — явно, `author.module.ts`). Отсюда берётся
 * резолвинг `authorId` по имени; взять его из `BookVersionService` было нельзя —
 * `BookVersionModule` импортирует этот модуль, получилось бы кольцо. Добавлять в `AuthorModule`
 * импорт доменного модуля нельзя: его держат четверо, и первое же такое ребро вернёт кольцо.
 */
@Module({
  imports: [
    PersonsModule,
    RightsLicensesModule,
    RightsNotificationsModule,
    RightsContentHashModule,
    RightsFileStorageModule,
    AuthorModule,
  ],
  controllers: [
    RightsIntakeController,
    RightsReviewImportController,
    RightsProfileController,
    RightsActionController,
    RightsFilesController,
  ],
  providers: [
    RightsIntakeService,
    RightsIntakeManifestService,
    RightsReviewImportService,
    RightsReviewImportValidator,
    RightsMaterializationService,
    RightsProfileService,
    RightsFilesService,
    RightsActionService,
    RightsApprovalService,
    RightsBookCreationService,
    TerritoryRegionAggregationService,
    ComponentTerritoryAggregationService,
  ],
  exports: [
    RightsIntakeService,
    RightsProfileService,
    RightsContentHashModule,
    TerritoryRegionAggregationService,
    ComponentTerritoryAggregationService,
    RightsReviewImportService,
    RightsMaterializationService,
    RightsIntakeManifestService,
    RightsActionService,
  ],
})
export class RightsIntakeModule {}
