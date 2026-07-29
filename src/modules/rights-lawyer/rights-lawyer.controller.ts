import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RightsLawyerService } from './rights-lawyer.service';
import { CreateLawyerDto } from './dto/create-lawyer.dto';
import { ListLawyersDto } from './dto/list-lawyers.dto';
import { DeactivateLawyerDto } from './dto/reason.dto';
import { UpdateLawyerDto } from './dto/update-lawyer.dto';
import type { LawyerDetailDto, LawyersListResponseDto } from './dto/lawyer-response.dto';

/**
 * Directory of lawyers. Reading is open to every role that touches the legal workflow;
 * writing is admin-only — a lawyer must never be able to invent a colleague for themselves.
 */
@ApiTags('rights-lawyer')
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin, Role.ContentManager, Role.Lawyer)
@ApiBearerAuth()
export class RightsLawyerController {
  constructor(private readonly lawyers: RightsLawyerService) {}

  @Get('admin/rights/lawyers')
  @ApiOperation({ summary: 'List lawyers' })
  list(@Query() query: ListLawyersDto): Promise<LawyersListResponseDto> {
    return this.lawyers.list(query);
  }

  @Get('admin/rights/lawyers/:id')
  @ApiOperation({ summary: 'Lawyer details' })
  getById(@Param('id') id: string): Promise<LawyerDetailDto> {
    return this.lawyers.getById(id);
  }

  @Post('admin/rights/lawyers')
  @Roles(Role.Admin)
  @ApiOperation({ summary: 'Create a lawyer (admin only)' })
  create(
    @Body() dto: CreateLawyerDto,
    @Req() req: { user: { userId: string } },
  ): Promise<LawyerDetailDto> {
    return this.lawyers.create(dto, req.user.userId);
  }

  @Patch('admin/rights/lawyers/:id')
  @Roles(Role.Admin)
  @ApiOperation({ summary: 'Update a lawyer (admin only)' })
  update(@Param('id') id: string, @Body() dto: UpdateLawyerDto): Promise<LawyerDetailDto> {
    return this.lawyers.update(id, dto);
  }

  @Post('admin/rights/lawyers/:id/deactivate')
  @Roles(Role.Admin)
  @ApiOperation({ summary: 'Deactivate a lawyer, reason required (admin only)' })
  deactivate(
    @Param('id') id: string,
    @Body() dto: DeactivateLawyerDto,
    @Req() req: { user: { userId: string } },
  ): Promise<LawyerDetailDto> {
    return this.lawyers.deactivate(id, dto, req.user.userId);
  }

  @Post('admin/rights/lawyers/:id/activate')
  @Roles(Role.Admin)
  @ApiOperation({ summary: 'Bring a lawyer back into service (admin only)' })
  activate(@Param('id') id: string): Promise<LawyerDetailDto> {
    return this.lawyers.activate(id);
  }
}
