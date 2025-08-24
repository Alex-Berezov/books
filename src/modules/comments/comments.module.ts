import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CommentsService } from './comments.service';
import { CommentsController } from './comments.controller';
import { RateLimitModule } from '../../shared/rate-limit/rate-limit.module';

@Module({
  imports: [RateLimitModule],
  controllers: [CommentsController],
  providers: [PrismaService, CommentsService],
})
export class CommentsModule {}
