import { Module } from '@nestjs/common';
import { BookVersionService } from './book-version.service';
import { BookVersionController } from './book-version.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { RolesGuard } from '../../common/guards/roles.guard';

@Module({
  controllers: [BookVersionController],
  providers: [BookVersionService, PrismaService, RolesGuard],
  exports: [BookVersionService],
})
export class BookVersionModule {}
