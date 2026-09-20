import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { AdminAuditModule } from '../../shared/admin-audit/admin-audit.module';

@Module({
  // Общий писатель журнала (`LEGACY-015`): удаление пользователя пишет `USER_DELETED`
  // им, а не копией `adminAuditEvent` по месту.
  imports: [AdminAuditModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
