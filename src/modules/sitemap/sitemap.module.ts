import { Module } from '@nestjs/common';
import { SitemapService } from './sitemap.service';
import { SitemapController } from './sitemap.controller';

@Module({
  controllers: [SitemapController],
  providers: [SitemapService],
})
export class SitemapModule {}
