import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheModule } from '../../shared/cache/cache.module';
import { LikesController } from './likes.controller';
import { LikesService } from './likes.service';

@Module({
  imports: [CacheModule],
  controllers: [LikesController],
  providers: [LikesService, PrismaService],
  exports: [LikesService],
})
export class LikesModule {}
