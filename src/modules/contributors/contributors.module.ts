import { Module } from '@nestjs/common';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { ContributorsController } from './contributors.controller';
import { ContributorsService } from './contributors.service';

@Module({
  imports: [PrismaModule],
  controllers: [ContributorsController],
  providers: [ContributorsService],
  exports: [ContributorsService],
})
export class ContributorsModule {}
