import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles, Role } from '../../common/decorators/roles.decorator';
import { RightsMaterializationService } from './rights-materialization.service';
import { RightsProfileService } from './rights-profile.service';
import { RightsProfileDetailDto, RightsProfileListDto } from './dto/rights-profile-response.dto';

@ApiTags('Rights Profiles')
@Controller('admin/rights')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class RightsProfileController {
  constructor(
    private readonly materializationService: RightsMaterializationService,
    private readonly profileService: RightsProfileService,
  ) {}

  @Post('review-imports/:importId/materialize')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Materialize a rights profile from a validated review import' })
  async materialize(@Param('importId') importId: string): Promise<RightsProfileDetailDto> {
    const profile = await this.materializationService.materializeFromImport(importId);
    return this.profileService.getById(profile['id'] as string);
  }

  @Get('intakes/:id/rights-profile')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Get rights profile(s) for an intake' })
  @ApiQuery({
    name: 'currentOnly',
    required: false,
    type: Boolean,
    description: 'Return only current profile (default: true)',
  })
  async getByIntake(
    @Param('id') intakeId: string,
    @Query('currentOnly') currentOnly?: string,
  ): Promise<RightsProfileDetailDto | RightsProfileListDto> {
    const isCurrentOnly = currentOnly !== 'false';
    if (isCurrentOnly) {
      return this.profileService.getCurrentByIntake(intakeId);
    }
    const items = await this.profileService.listByIntake(intakeId);
    return { items, total: items.length };
  }

  @Get('profiles/:profileId')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Get rights profile detail by ID' })
  async getById(@Param('profileId') profileId: string): Promise<RightsProfileDetailDto> {
    return this.profileService.getById(profileId);
  }
}
