import { Module } from '@nestjs/common';
import { GeoBlockModule } from '../geo-block/geo-block.module';
import { BookAnalysisService } from './book-analysis.service';
import { BookAnalysisController } from './book-analysis.controller';

@Module({
  imports: [GeoBlockModule],
  controllers: [BookAnalysisController],
  providers: [BookAnalysisService],
})
export class BookAnalysisModule {}
