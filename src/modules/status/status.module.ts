import { Module } from '@nestjs/common';
import { StatusController } from './status.controller';
import { RolesGuard } from '../../common/guards/roles.guard';

@Module({
  controllers: [StatusController],
  providers: [RolesGuard],
})
export class StatusModule {}
