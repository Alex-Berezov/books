import { Module } from '@nestjs/common';
import { AudioChapterService } from './audio-chapter.service';
import { AudioChapterController } from './audio-chapter.controller';
import { RightsIntakeModule } from '../rights-intake/rights-intake.module';
import { GeoBlockModule } from '../geo-block/geo-block.module';
import { AdminAuditModule } from '../../shared/admin-audit/admin-audit.module';

@Module({
  imports: [RightsIntakeModule, GeoBlockModule, AdminAuditModule],
  controllers: [AudioChapterController],
  providers: [AudioChapterService],
  exports: [AudioChapterService],
})
export class AudioChapterModule {}
