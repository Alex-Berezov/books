import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { BookSummaryService } from './book-summary.service';
import { BookSummaryController } from './book-summary.controller';

@Module({
  controllers: [BookSummaryController],
  providers: [BookSummaryService, PrismaService, RolesGuard],
  exports: [BookSummaryService],
})
export class BookSummaryModule {}
