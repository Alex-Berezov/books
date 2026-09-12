import { Module } from '@nestjs/common';
import { AdminAuditService } from './admin-audit.service';

/**
 * Модуль общего писателя журнала административных действий. Не `@Global`: писателей
 * журнала должно быть видно по импортам, а не по тому, что сервис доступен всюду.
 * `PrismaService` в `providers` не объявляется — клиент приходит параметром `tx`
 * от вызывающей транзакции (правило `B17`: лишний провайдер завёл бы второй пул).
 */
@Module({
  providers: [AdminAuditService],
  exports: [AdminAuditService],
})
export class AdminAuditModule {}
