import { Module } from '@nestjs/common';
import { GeoBlockModule } from '../geo-block/geo-block.module';
import { BookSummaryService } from './book-summary.service';
import { BookSummarySectionsService } from './book-summary-sections.service';
import { BookSummaryController } from './book-summary.controller';

@Module({
  // `GeoBlockModule` — за `GeoBlockRuleService` (претензия на разделах) и `GeoIpCountryService`.
  imports: [GeoBlockModule],
  controllers: [BookSummaryController],
  providers: [BookSummaryService, BookSummarySectionsService],
  exports: [BookSummaryService, BookSummarySectionsService],
})
export class BookSummaryModule {}
