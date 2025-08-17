import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AudioChapterService } from './audio-chapter.service';
import { AudioChapterController } from './audio-chapter.controller';

@Module({
  controllers: [AudioChapterController],
  providers: [AudioChapterService, PrismaService, RolesGuard],
  exports: [AudioChapterService],
})
export class AudioChapterModule {}
