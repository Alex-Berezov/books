import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RightsLegalChangeService } from './rights-legal-change.service';
import { CreateLegalChangeDto } from './dto/create-legal-change.dto';
import { ListLegalChangesDto } from './dto/list-legal-changes.dto';
import { UpdateLegalChangeDto } from './dto/update-legal-change.dto';
import type {
  LegalChangeDetailDto,
  LegalChangeDto,
  LegalChangeListResponseDto,
} from './dto/legal-change-response.dto';

/** `apply` and `archive` touch the whole catalogue, so they are admin-only. */
@ApiTags('rights-legal-changes')
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin, Role.ContentManager)
@ApiBearerAuth()
export class RightsLegalChangeController {
  constructor(private readonly legalChanges: RightsLegalChangeService) {}

  @Get('admin/rights/legal-changes')
  @ApiOperation({ summary: 'List declared legal changes' })
  list(@Query() query: ListLegalChangesDto): Promise<LegalChangeListResponseDto> {
    return this.legalChanges.list(query);
  }

  @Post('admin/rights/legal-changes')
  @ApiOperation({ summary: 'Declare a legal change (DRAFT)' })
  create(
    @Body() dto: CreateLegalChangeDto,
    @Req() req: { user: { userId: string } },
  ): Promise<LegalChangeDto> {
    return this.legalChanges.create(dto, req.user.userId);
  }

  @Get('admin/rights/legal-changes/:id')
  @ApiOperation({ summary: 'Legal change details with the tasks it opened' })
  getById(@Param('id') id: string): Promise<LegalChangeDetailDto> {
    return this.legalChanges.getById(id);
  }

  @Patch('admin/rights/legal-changes/:id')
  @ApiOperation({ summary: 'Edit a DRAFT legal change' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateLegalChangeDto,
    @Req() req: { user: { userId: string } },
  ): Promise<LegalChangeDto> {
    return this.legalChanges.update(id, dto, req.user.userId);
  }

  @Post('admin/rights/legal-changes/:id/apply')
  @Roles(Role.Admin)
  @ApiOperation({ summary: 'Apply a legal change: open recheck tasks in bulk (admin only)' })
  apply(
    @Param('id') id: string,
    @Req() req: { user: { userId: string } },
  ): Promise<LegalChangeDetailDto> {
    return this.legalChanges.apply(id, req.user.userId);
  }

  @Post('admin/rights/legal-changes/:id/archive')
  @Roles(Role.Admin)
  @ApiOperation({ summary: 'Archive a legal change (admin only)' })
  archive(
    @Param('id') id: string,
    @Req() req: { user: { userId: string } },
  ): Promise<LegalChangeDto> {
    return this.legalChanges.archive(id, req.user.userId);
  }
}
