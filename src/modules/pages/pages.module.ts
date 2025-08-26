import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PagesService } from './pages.service';
import { PagesController } from './pages.controller';

@Module({
  controllers: [PagesController],
  providers: [PrismaService, PagesService],
  exports: [PagesService],
})
export class PagesModule {}
