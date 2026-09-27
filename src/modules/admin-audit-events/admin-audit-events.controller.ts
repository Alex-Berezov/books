import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PaginationInfoDto, paginatedSchema } from '../../shared/dto/paginated-response.dto';
import { AdminAuditEventsService } from './admin-audit-events.service';
import { AdminAuditEventResponseDto } from './dto/admin-audit-event-response.dto';
import { ListAdminAuditEventsQueryDto } from './dto/list-admin-audit-events-query.dto';

/**
 * Журнал административных действий наружу (`LEGACY-015` пункт 3). Только `admin`:
 * в журнале смены ролей и удаления самих людей, `content_manager` его не читает
 * (решение арбитра 27.09.2026).
 */
@ApiTags('admin')
@ApiExtraModels(AdminAuditEventResponseDto, PaginationInfoDto)
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/audit-events')
export class AdminAuditEventsController {
  constructor(private readonly events: AdminAuditEventsService) {}

  @ApiOperation({
    summary: 'Admin audit log (admin only)',
    description:
      'Rows of the admin action journal, newest first. targetId requires targetType. Actor is returned as id only: the journal carries no emails or names.',
  })
  @ApiOkResponse({ schema: paginatedSchema(AdminAuditEventResponseDto) })
  @Roles(Role.Admin)
  @Get()
  list(@Query() query: ListAdminAuditEventsQueryDto) {
    return this.events.list(query);
  }
}
