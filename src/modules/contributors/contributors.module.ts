import { Module } from '@nestjs/common';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { PersonsModule } from '../persons/persons.module';
import { RightsContentHashModule } from '../rights-intake/rights-content-hash.module';
import { ContributorsController } from './contributors.controller';
import { ContributorsService } from './contributors.service';

@Module({
  imports: [PrismaModule, PersonsModule, RightsContentHashModule],
  controllers: [ContributorsController],
  providers: [ContributorsService],
  exports: [ContributorsService],
})
export class ContributorsModule {}
