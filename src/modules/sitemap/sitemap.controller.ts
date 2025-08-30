import { Controller, Get, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import { SitemapService } from './sitemap.service';
import { ApiOperation, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import { LangParamPipe } from '../../common/pipes/lang-param.pipe';
import { Language } from '@prisma/client';

@ApiTags('sitemap')
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
