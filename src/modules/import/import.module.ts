import { Module } from '@nestjs/common';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';
import { CategoryTreeModule } from '../category/category-tree.module';

@Module({
  imports: [CategoryTreeModule],
  controllers: [ImportController],
  providers: [ImportService],
})
export class ImportModule {}
