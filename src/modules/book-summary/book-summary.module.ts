import { Module } from '@nestjs/common';
import { BookSummaryService } from './book-summary.service';
import { BookSummaryController } from './book-summary.controller';

@Module({
  controllers: [BookSummaryController],
  providers: [BookSummaryService],
  exports: [BookSummaryService],
})
export class BookSummaryModule {}
