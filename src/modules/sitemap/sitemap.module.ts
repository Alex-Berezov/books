import { Module } from '@nestjs/common';
import { SitemapService } from './sitemap.service';
import { SitemapController } from './sitemap.controller';
import { PrismaService } from '../../prisma/prisma.service';

@Module({
  controllers: [SitemapController],
  providers: [SitemapService, PrismaService],
})
export class SitemapModule {}
