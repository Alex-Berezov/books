import { Module } from '@nestjs/common';
import { AdminAuditEventsController } from './admin-audit-events.controller';
import { AdminAuditEventsService } from './admin-audit-events.service';

/**
 * Читатель журнала (`GET /admin/audit-events`). Отдельно от писателя
 * `src/shared/admin-audit`: писателей видно по импорту `AdminAuditModule`,
 * и читатель в этот перечень попадать не должен.
 */
@Module({
  controllers: [AdminAuditEventsController],
  providers: [AdminAuditEventsService],
})
export class AdminAuditEventsModule {}
