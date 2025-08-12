import { Module } from '@nestjs/common';
import { BookVersionService } from './book-version.service';
import { BookVersionController } from './book-version.controller';
import { PrismaService } from '../../prisma/prisma.service';

@Module({
  controllers: [BookVersionController],
  providers: [BookVersionService, PrismaService],
  exports: [BookVersionService],
})
export class BookVersionModule {}
