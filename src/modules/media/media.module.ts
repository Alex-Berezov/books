import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { StorageModule } from '../../shared/storage/storage.module';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadsModule } from '../uploads/uploads.module';

@Module({
  imports: [StorageModule, UploadsModule],
  controllers: [MediaController],
  providers: [PrismaService, MediaService],
})
export class MediaModule {}
