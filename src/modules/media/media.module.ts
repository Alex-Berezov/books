import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { StorageModule } from '../../shared/storage/storage.module';
import { PrismaService } from '../../prisma/prisma.service';

@Module({
  imports: [StorageModule],
  controllers: [MediaController],
  providers: [PrismaService, MediaService],
})
export class MediaModule {}
