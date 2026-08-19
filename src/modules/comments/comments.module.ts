import { Module } from '@nestjs/common';
import { CommentsService } from './comments.service';
import { CommentsController } from './comments.controller';
import { RateLimitModule } from '../../shared/rate-limit/rate-limit.module';

@Module({
  imports: [RateLimitModule],
  controllers: [CommentsController],
  providers: [CommentsService],
})
export class CommentsModule {}
