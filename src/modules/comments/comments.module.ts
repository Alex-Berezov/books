import { Module } from '@nestjs/common';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PrismaService } from '../../prisma/prisma.service';
import { CommentsService } from './comments.service';
import { CommentsController } from './comments.controller';
import { RateLimitModule } from '../../shared/rate-limit/rate-limit.module';

@Module({
  imports: [RateLimitModule],
  controllers: [CommentsController],
  providers: [PrismaService, CommentsService, RolesGuard],
})
export class CommentsModule {}
