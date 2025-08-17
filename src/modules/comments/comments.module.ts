import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CommentsService } from './comments.service';
import { CommentsController } from './comments.controller';

@Module({
  controllers: [CommentsController],
  providers: [PrismaService, CommentsService],
})
export class CommentsModule {}
