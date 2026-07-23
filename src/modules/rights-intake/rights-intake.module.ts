import { Module } from '@nestjs/common';
import { RightsIntakeService } from './rights-intake.service';
import { RightsIntakeManifestService } from './rights-intake-manifest.service';
import { RightsIntakeController } from './rights-intake.controller';
import { PrismaService } from '../../prisma/prisma.service';

@Module({
  controllers: [RightsIntakeController],
  providers: [RightsIntakeService, RightsIntakeManifestService, PrismaService],
  exports: [RightsIntakeService],
})
export class RightsIntakeModule {}
