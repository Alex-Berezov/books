import { Module } from '@nestjs/common';
import { TagLockService } from './tag-lock.service';

/**
 * Отдельный модуль, а не экспорт `TagsModule`: замок нужен импорту
 * (`ImportModule`), а тянуть ради него весь `TagsService` вместе с его
 * зависимостями значит связать два модуля там, где общего — одна строка SQL.
 * Тот же ход и по той же причине сделан у категорий (`CategoryTreeModule`).
 */
@Module({
  providers: [TagLockService],
  exports: [TagLockService],
})
export class TagLockModule {}
