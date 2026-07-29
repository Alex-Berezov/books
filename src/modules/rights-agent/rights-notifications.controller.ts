import { Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RightsNotificationsService } from './rights-notifications.service';
import { ListRightsNotificationsDto } from './dto/list-rights-notifications.dto';
import type {
  RightsNotificationDto,
  RightsNotificationsListResponseDto,
  RightsNotificationsMarkAllReadDto,
  RightsNotificationsUnreadCountDto,
} from './dto/rights-notification-response.dto';

@ApiTags('rights-notifications')
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
// Phase 19: юрист должен видеть адресованные ему уведомления — иначе назначение проверки
// до него просто не дойдёт. Собственные уведомления фильтруются по targetUserId в сервисе.
@Roles(Role.Admin, Role.ContentManager, Role.Lawyer)
@ApiBearerAuth()
export class RightsNotificationsController {
  constructor(private readonly service: RightsNotificationsService) {}

  @Get('admin/rights/notifications')
  @ApiOperation({ summary: 'List in-app rights notifications visible to the current user' })
  list(
    @Query() query: ListRightsNotificationsDto,
    @Req() req: { user: { userId: string } },
  ): Promise<RightsNotificationsListResponseDto> {
    return this.service.list(req.user.userId, query);
  }

  // Declared before the parameterised routes so `unread-count` is never parsed as an id.
  @Get('admin/rights/notifications/unread-count')
  @ApiOperation({ summary: 'Number of unread notifications' })
  unreadCount(
    @Req() req: { user: { userId: string } },
  ): Promise<RightsNotificationsUnreadCountDto> {
    return this.service.unreadCount(req.user.userId);
  }

  @Post('admin/rights/notifications/read-all')
  @ApiOperation({ summary: 'Mark every visible notification as read' })
  markAllRead(
    @Req() req: { user: { userId: string } },
  ): Promise<RightsNotificationsMarkAllReadDto> {
    return this.service.markAllRead(req.user.userId);
  }

  @Post('admin/rights/notifications/:id/read')
  @ApiOperation({ summary: 'Mark one notification as read' })
  markRead(
    @Param('id') id: string,
    @Req() req: { user: { userId: string } },
  ): Promise<RightsNotificationDto> {
    return this.service.markRead(id, req.user.userId);
  }
}
