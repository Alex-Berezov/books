import { Body, Controller, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { RightsActionService } from './rights-action.service';
import { RightsActionDto } from './dto/rights-profile-response.dto';
import { UpdateRightsActionDto } from './dto/update-rights-action.dto';

@ApiTags('Rights Profiles')
@Controller('admin/rights/actions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin, Role.ContentManager)
@ApiBearerAuth()
export class RightsActionController {
  constructor(private readonly service: RightsActionService) {}

  @Get(':actionId')
  @ApiOperation({ summary: 'Get a required rights action by id' })
  async getById(@Param('actionId') actionId: string): Promise<RightsActionDto> {
    return this.service.getById(actionId);
  }

  @Patch(':actionId')
  @ApiOperation({
    summary: 'Update a required rights action (status, assignee, due date, comment)',
    description:
      'WP-5.2: действие предлагает агент, закрывает человек. Комментарий обязателен при WAIVED; ' +
      'каждое изменение пишет неудаляемое событие в той же транзакции.',
  })
  async update(
    @Param('actionId') actionId: string,
    @Body() dto: UpdateRightsActionDto,
    @Req() req: { user: { userId: string } },
  ): Promise<RightsActionDto> {
    return this.service.update(actionId, dto, req.user?.userId ?? null);
  }
}
