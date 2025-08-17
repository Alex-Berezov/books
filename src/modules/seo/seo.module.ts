import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { SeoService } from './seo.service';
import { SeoController } from './seo.controller';

@Module({
  controllers: [SeoController],
  providers: [SeoService, PrismaService, RolesGuard],
  exports: [SeoService],
})
export class SeoModule {}
