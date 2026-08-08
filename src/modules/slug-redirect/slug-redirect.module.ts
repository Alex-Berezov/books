import { Global, Module } from '@nestjs/common';
import { SlugRedirectService } from './slug-redirect.service';

/**
 * Глобальный намеренно: запись редиректа обязана происходить рядом с **каждой**
 * сменой слага публичной сущности (LEGACY-062), а таких мест будет больше, чем
 * таксономии — страницы, книги, авторы. Модуль, который надо не забыть импортировать,
 * рано или поздно забудут, и потеря URL пройдёт молча, как уже проходила.
 */
@Global()
@Module({
  providers: [SlugRedirectService],
  exports: [SlugRedirectService],
})
export class SlugRedirectModule {}
