import { Global, Module } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ModeratorRolesService } from './moderator-roles.service';

/**
 * Глобальный, чтобы проверку роли можно было позвать из любого модуля, не
 * протаскивая её через импорты, — и, главное, чтобы не появилась пятая копия
 * одной и той же логики.
 */
@Global()
@Module({
  providers: [ModeratorRolesService, PrismaService],
  exports: [ModeratorRolesService],
})
export class ModeratorRolesModule {}
