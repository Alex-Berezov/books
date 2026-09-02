import { Module } from '@nestjs/common';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';
import { CategoryTreeModule } from '../category/category-tree.module';
import { TagLockModule } from '../tags/tag-lock.module';

@Module({
  imports: [CategoryTreeModule, TagLockModule],
  controllers: [ImportController],
  providers: [ImportService],
})
export class ImportModule {}
