import { Module } from '@nestjs/common';
import { SystemPagesService } from './system-pages.service';

@Module({
  providers: [SystemPagesService],
  exports: [SystemPagesService],
})
export class SystemPagesModule {}
