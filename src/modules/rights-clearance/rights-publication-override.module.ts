import { Module } from '@nestjs/common';
import { RightsClearanceModule } from './rights-clearance.module';
import { RightsPublicationOverrideController } from './rights-publication-override.controller';

/**
 * Админские ручки «Разрешить публикацию» (решение владельца 27.09.2026). Отдельный модуль, а не
 * контроллер внутри `RightsClearanceModule`: тот — лист, который импортируют гейт, geo-block
 * и покрытие лицензий, и guard'ы контроллера с их зависимостями в листе вернули бы цикл
 * (ADR-013 п.5). Сервис журнала остаётся в листе — его читает гейт.
 */
@Module({
  imports: [RightsClearanceModule],
  controllers: [RightsPublicationOverrideController],
})
export class RightsPublicationOverrideModule {}
