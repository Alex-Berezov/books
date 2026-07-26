import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AudioChapterService } from './audio-chapter.service';
import { AudioChapterController } from './audio-chapter.controller';
import { RightsIntakeModule } from '../rights-intake/rights-intake.module';
import { GeoBlockModule } from '../geo-block/geo-block.module';

@Module({
  imports: [RightsIntakeModule, GeoBlockModule],
  controllers: [AudioChapterController],
  providers: [AudioChapterService, PrismaService, RolesGuard],
  exports: [AudioChapterService],
})
export class AudioChapterModule {}
