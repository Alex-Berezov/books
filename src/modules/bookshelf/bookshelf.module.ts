import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BookshelfController } from './bookshelf.controller';
import { BookshelfService } from './bookshelf.service';

@Module({
  controllers: [BookshelfController],
  providers: [BookshelfService, PrismaService],
  exports: [BookshelfService],
})
export class BookshelfModule {}
