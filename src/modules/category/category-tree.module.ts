import { Module } from '@nestjs/common';
import { CategoryTreeService } from './category-tree.service';

/**
 * Отдельный модуль, а не экспорт `CategoryModule`: подъём по дереву нужен
 * импорту (`ImportModule`), а тянуть ради него весь `CategoryService` вместе с
 * его зависимостями значит связать два модуля там, где общего — одна проверка.
 */
@Module({
  providers: [CategoryTreeService],
  exports: [CategoryTreeService],
})
export class CategoryTreeModule {}
