import { Module } from '@nestjs/common';
import { RightsContentHashModule } from '../rights-intake/rights-content-hash.module';
import { PrismaService } from '../../prisma/prisma.service';
import { PersonResolverService } from './person-resolver.service';
import { PersonsController } from './persons.controller';
import { PersonsService } from './persons.service';

/**
 * WP-8.1: `RightsContentHashModule` — лист графа, поэтому импорт отсюда цикла не создаёт,
 * хотя `RightsIntakeModule` импортирует персон.
 */
@Module({
  imports: [RightsContentHashModule],
  controllers: [PersonsController],
  providers: [PersonsService, PersonResolverService, PrismaService],
  exports: [PersonsService, PersonResolverService],
})
export class PersonsModule {}
