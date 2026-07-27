import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PersonResolverService } from './person-resolver.service';
import { PersonsController } from './persons.controller';
import { PersonsService } from './persons.service';

@Module({
  controllers: [PersonsController],
  providers: [PersonsService, PersonResolverService, PrismaService],
  exports: [PersonsService, PersonResolverService],
})
export class PersonsModule {}
