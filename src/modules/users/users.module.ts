import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { AdminAuditModule } from '../../shared/admin-audit/admin-audit.module';
import { StorageModule } from '../../shared/storage/storage.module';

@Module({
  // Общий писатель журнала (`LEGACY-015`): удаление пользователя пишет `USER_DELETED`
  // им, а не копией `adminAuditEvent` по месту. Хранилище — сверка аватара с базой загрузки (`LEGACY-455`).
  imports: [AdminAuditModule, StorageModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
