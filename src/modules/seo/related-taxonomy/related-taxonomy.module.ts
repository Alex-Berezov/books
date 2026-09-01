import { Module } from '@nestjs/common';
import { RelatedTaxonomyService } from './related-taxonomy.service';

/**
 * Модуль-владелец `RelatedTaxonomyService` (`LEGACY-260`). До 01.09.2026 сервис объявлялся
 * в `providers` `BookModule` и `PublicModule` сразу, то есть у книг и у публичных маршрутов
 * были свои экземпляры. `imports` не нужен: единственная зависимость сервиса — `PrismaService`,
 * а он раздаётся глобальным модулем из `src/shared/prisma`.
 */
@Module({
  providers: [RelatedTaxonomyService],
  exports: [RelatedTaxonomyService],
})
export class RelatedTaxonomyModule {}
