import { Module } from '@nestjs/common';
import { ChapterService } from './chapter.service';
import { ChapterController } from './chapter.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { RolesGuard } from '../../common/guards/roles.guard';

@Module({
  controllers: [ChapterController],
  providers: [ChapterService, PrismaService, RolesGuard],
  exports: [ChapterService],
})
export class ChapterModule {}
