import { Module } from '@nestjs/common';
import { ChapterService } from './chapter.service';
import { ChapterController } from './chapter.controller';
import { RightsIntakeModule } from '../rights-intake/rights-intake.module';
import { GeoBlockModule } from '../geo-block/geo-block.module';
import { AdminAuditModule } from '../../shared/admin-audit/admin-audit.module';

@Module({
  imports: [RightsIntakeModule, GeoBlockModule, AdminAuditModule],
  controllers: [ChapterController],
  providers: [ChapterService],
  exports: [ChapterService],
})
export class ChapterModule {}
