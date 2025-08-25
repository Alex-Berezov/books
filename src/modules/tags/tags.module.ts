import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TagsService } from './tags.service';
import { TagsController } from './tags.controller';

@Module({
  controllers: [TagsController],
  providers: [PrismaService, TagsService],
  exports: [TagsService],
})
export class TagsModule {}
