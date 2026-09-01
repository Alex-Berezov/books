import { Module } from '@nestjs/common';
import { PublicController } from './public.controller';
import { AuthorModule } from '../author/author.module';
import { BookModule } from '../book/book.module';
import { CategoryModule } from '../category/category.module';
import { GeoBlockModule } from '../geo-block/geo-block.module';
import { PagesModule } from '../pages/pages.module';
import { TagsModule } from '../tags/tags.module';

@Module({
  // Сервисы берутся из модулей-владельцев, а не объявляются заново (`LEGACY-260`): собственный
  // провайдер дал бы публичным маршрутам свой экземпляр, отдельный от экземпляра родного модуля.
  // `GeoBlockModule` — за `GeoIpCountryService`, который контроллер инжектит напрямую.
  imports: [AuthorModule, BookModule, CategoryModule, GeoBlockModule, PagesModule, TagsModule],
  // `providers` пуст намеренно: `LanguageResolverGuard` раздаётся глобально
  // (`app.module.ts`, `APP_GUARD`), `LangParamPipe` Nest поднимает сам по классу в параметре,
  // и пять соседних модулей зовут обоих без единой строки здесь (`LEGACY-259`).
  controllers: [PublicController],
})
export class PublicModule {}
