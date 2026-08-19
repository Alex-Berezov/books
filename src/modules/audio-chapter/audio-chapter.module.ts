import { Module } from '@nestjs/common';
import { AudioChapterService } from './audio-chapter.service';
import { AudioChapterController } from './audio-chapter.controller';
import { RightsIntakeModule } from '../rights-intake/rights-intake.module';
import { GeoBlockModule } from '../geo-block/geo-block.module';

@Module({
  imports: [RightsIntakeModule, GeoBlockModule],
  controllers: [AudioChapterController],
  providers: [AudioChapterService],
  exports: [AudioChapterService],
})
export class AudioChapterModule {}
