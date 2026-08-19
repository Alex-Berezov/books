import { Module } from '@nestjs/common';
import { ChapterService } from './chapter.service';
import { ChapterController } from './chapter.controller';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RightsIntakeModule } from '../rights-intake/rights-intake.module';
import { GeoBlockModule } from '../geo-block/geo-block.module';

@Module({
  imports: [RightsIntakeModule, GeoBlockModule],
  controllers: [ChapterController],
  providers: [ChapterService, RolesGuard],
  exports: [ChapterService],
})
export class ChapterModule {}
