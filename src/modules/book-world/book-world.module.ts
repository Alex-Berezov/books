import { Module } from '@nestjs/common';
import { BookWorldService } from './book-world.service';
import { BookWorldController } from './book-world.controller';

/**
 * Мир книги (F08). `BookWorldService` экспортируется для хода «Write World» (`F08-4`) и подсчёта
 * упоминаний (`F08-2`); чтение для читателя — только ручкой.
 */
@Module({
  controllers: [BookWorldController],
  providers: [BookWorldService],
  exports: [BookWorldService],
})
export class BookWorldModule {}
