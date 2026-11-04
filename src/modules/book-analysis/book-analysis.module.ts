import { Module } from '@nestjs/common';
import { GeoBlockModule } from '../geo-block/geo-block.module';
import { BookAnalysisService } from './book-analysis.service';
import { BookAnalysisController } from './book-analysis.controller';

/**
 * `BookAnalysisService` экспортируется ради записи хода анализа `F07` (`saveGuarded`, решение
 * арбитра `F07 | F07-1`, В5): чтение `getByVersion` с проверкой прав и гео идёт только ручкой.
 */
@Module({
  imports: [GeoBlockModule],
  controllers: [BookAnalysisController],
  providers: [BookAnalysisService],
  exports: [BookAnalysisService],
})
export class BookAnalysisModule {}
