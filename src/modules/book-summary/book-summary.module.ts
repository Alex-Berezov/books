import { Module } from '@nestjs/common';
import { RolesGuard } from '../../common/guards/roles.guard';
import { BookSummaryService } from './book-summary.service';
import { BookSummaryController } from './book-summary.controller';

@Module({
  controllers: [BookSummaryController],
  providers: [BookSummaryService, RolesGuard],
  exports: [BookSummaryService],
})
export class BookSummaryModule {}
