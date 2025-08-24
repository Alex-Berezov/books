import { Module } from '@nestjs/common';
import { StatusController } from './status.controller';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PrismaService } from '../../prisma/prisma.service';

@Module({
  controllers: [StatusController],
  providers: [PrismaService, RolesGuard],
})
export class StatusModule {}
