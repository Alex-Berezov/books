import { Module } from '@nestjs/common';
import { ReadingProgressController } from './reading-progress.controller';
import { ReadingProgressService } from './reading-progress.service';
import { PrismaService } from '../../prisma/prisma.service';

@Module({
  controllers: [ReadingProgressController],
  providers: [ReadingProgressService, PrismaService],
})
export class ReadingProgressModule {}
