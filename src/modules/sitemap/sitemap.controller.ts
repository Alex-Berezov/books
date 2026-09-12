import { Controller, Get, Param, Res, UseInterceptors } from '@nestjs/common';
import { Response } from 'express';
import { SitemapService } from './sitemap.service';
import { ApiOperation, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import { LangParamPipe } from '../../common/pipes/lang-param.pipe';
import { PublicCacheInterceptor } from '../../common/interceptors/public-cache.interceptor';
import { Language } from '@prisma/client';

/**
 * 🔴 `LEGACY-108`. Интерцептор здесь нужен ровно затем, чтобы объявить эти три
 * документа публичными. Своего `Cache-Control` у них не было никогда, а после
 * инверсии умолчания 12.09.2026 они стали получать `private, no-store`
 * от `DefaultCacheControlMiddleware` — неверно по смыслу: карта сайта
 * и `robots.txt` одинаковы для всех и от запрашивающего не зависят.
 *
 * Интерцептор, а не `@Header` с литералом: значение берётся из общей константы
 * `PUBLIC_CACHE`, и второй копии строки в репозитории не появляется.
 * Решение арбитра 12.09.2026, вариант A (`decisions-log.md`).
 *
 * ⚠️ Обработчики отдают ответ сами — `@Res()` без `passthrough`. Заголовок при
 * этом успевает встать: интерцептор пишет его в фазе «до», ещё до `res.send()`.
 * Доказывает это только живой прогон, а не чтение кода, — кейсы в
 * `test/cache-headers.e2e-spec.ts`.
 */
@ApiTags('sitemap')
@UseInterceptors(PublicCacheInterceptor)
@Controller()
export class SitemapController {
  constructor(private readonly service: SitemapService) {}

  @Get('sitemap.xml')
  @ApiOperation({ summary: 'Sitemap index (per-language)' })
  @ApiProduces('application/xml')
  sitemapIndex(@Res() res: Response) {
    const { body, contentType } = this.service.sitemapIndex();
    res.setHeader('Content-Type', contentType);
    res.send(body);
  }

  @Get('sitemap-:lang.xml')
  @ApiOperation({ summary: 'Sitemap for specific language' })
  @ApiParam({ name: 'lang', enum: Object.values(Language) })
  @ApiProduces('application/xml')
  async sitemapForLang(@Param('lang', LangParamPipe) lang: Language, @Res() res: Response) {
    const { body, contentType } = await this.service.perLanguage(lang);
    res.setHeader('Content-Type', contentType);
    res.send(body);
  }

  @Get('robots.txt')
  @ApiOperation({ summary: 'Robots.txt' })
  @ApiProduces('text/plain')
  robots(@Res() res: Response) {
    const { body, contentType } = this.service.robots();
    res.setHeader('Content-Type', contentType);
    res.send(body);
  }
}
