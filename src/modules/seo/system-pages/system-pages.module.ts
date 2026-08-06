import { Module } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { SystemPagesService } from './system-pages.service';

@Module({
  providers: [SystemPagesService, PrismaService],
  exports: [SystemPagesService],
})
export class SystemPagesModule {}
