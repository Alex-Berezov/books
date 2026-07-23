import { Module } from '@nestjs/common';
import { RightsIntakeService } from './rights-intake.service';
import { RightsIntakeController } from './rights-intake.controller';
import { PrismaService } from '../../prisma/prisma.service';

@Module({
  controllers: [RightsIntakeController],
  providers: [RightsIntakeService, PrismaService],
  exports: [RightsIntakeService],
})
export class RightsIntakeModule {}
