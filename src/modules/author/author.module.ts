import { Module } from '@nestjs/common';
import { AuthorService } from './author.service';
import { AuthorController } from './author.controller';
import { SlugRedirectModule } from '../slug-redirect/slug-redirect.module';

/**
 * LEGACY-006: модуль стал листом, до которого дотягиваются `BookVersionModule`,
 * `RightsIntakeModule`, `BookModule` и `SeoModule` — за резолвингом `authorId`
 * по имени и за настоящими слагами авторов.
 *
 * 🔴 Доменные модули сюда импортировать нельзя — модуль обязан остаться листом, иначе
 * возвращается кольцо `BookVersionModule` ↔ `RightsIntakeModule`, ради обхода которого
 * резолвинг автора сюда и переехал. Ограничение записано в
 * `books-app-docs/ai-context/folder-structure.md`.
 *
 * ⚠️ `SlugRedirectModule` импортирован **явно**, хотя он и `@Global()`. Глобальный
 * модуль виден только тому, кто поднят вместе с `AppModule`; DI-smoke-спека
 * собирает модуль в одиночку, и `AuthorService` там падал на незаметной
 * зависимости. Список импортов обязан называть то, что сервису действительно
 * нужно, иначе «модуль без зависимостей» — неправда.
 */
@Module({
  imports: [SlugRedirectModule],
  controllers: [AuthorController],
  providers: [AuthorService],
  exports: [AuthorService],
})
export class AuthorModule {}
