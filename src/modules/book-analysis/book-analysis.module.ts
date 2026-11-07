import { Module } from '@nestjs/common';
import { BookAnalysisService } from './book-analysis.service';
import { BookAnalysisController } from './book-analysis.controller';

/**
 * `BookAnalysisService` экспортируется ради записи хода анализа `F07` (`saveGuarded`, решение
 * арбитра `F07 | F07-1`, В5): чтение `getByVersion` (черновик и анализ без ядра — только редактору) идёт только ручкой.
 */
@Module({
  controllers: [BookAnalysisController],
  providers: [BookAnalysisService],
  exports: [BookAnalysisService],
})
export class BookAnalysisModule {}
