import { Module } from '@nestjs/common';
import { BookService } from './book.service';
import { BookController } from './book.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { RolesGuard } from '../../common/guards/roles.guard';

@Module({
  controllers: [BookController],
  providers: [BookService, PrismaService, RolesGuard],
  exports: [BookService],
})
export class BookModule {}
