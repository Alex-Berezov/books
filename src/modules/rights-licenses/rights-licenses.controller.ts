import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CreateRightsLicenseDto } from './dto/create-rights-license.dto';
import { LinkRightsLicenseDto } from './dto/link-rights-license.dto';
import { QueryRightsLicensesDto } from './dto/query-rights-licenses.dto';
import { RevokeRightsLicenseDto } from './dto/revoke-rights-license.dto';
import {
  LicenseCoverageResultDto,
  RightsLicenseDetailDto,
  RightsLicenseLinkDto,
  RightsLicenseListResponseDto,
  UnlinkRightsLicenseResponseDto,
} from './dto/rights-license-response.dto';
import { UpdateRightsLicenseDto } from './dto/update-rights-license.dto';
import { RightsLicenseCoverageService } from './rights-license-coverage.service';
import { RightsLicensesService } from './rights-licenses.service';

@ApiTags('Rights Licenses')
@ApiBearerAuth()
@Controller('admin/rights')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RightsLicensesController {
  constructor(
    private readonly service: RightsLicensesService,
    private readonly coverageService: RightsLicenseCoverageService,
  ) {}

  @Get('licenses')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'List rights licenses' })
  @ApiResponse({ status: 200, type: RightsLicenseListResponseDto })
  findAll(@Query() query: QueryRightsLicensesDto): Promise<RightsLicenseListResponseDto> {
    return this.service.findAll(query);
  }

  @Get('licenses/:id')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Get a rights license with links and audit events' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: RightsLicenseDetailDto })
  findOne(@Param('id') id: string): Promise<RightsLicenseDetailDto> {
    return this.service.findOne(id);
  }

  @Post('licenses')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Create a rights license' })
  @ApiResponse({ status: 201, type: RightsLicenseDetailDto })
  create(
    @Body() dto: CreateRightsLicenseDto,
    @Req() request: { user: { userId: string } },
  ): Promise<RightsLicenseDetailDto> {
    return this.service.create(dto, request.user.userId);
  }

  @Patch('licenses/:id')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Update a rights license' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: RightsLicenseDetailDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRightsLicenseDto,
    @Req() request: { user: { userId: string } },
  ): Promise<RightsLicenseDetailDto> {
    return this.service.update(id, dto, request.user.userId);
  }

  @Post('licenses/:id/revoke')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Revoke a rights license (licenses are never deleted)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 201, type: RightsLicenseDetailDto })
  revoke(
    @Param('id') id: string,
    @Body() dto: RevokeRightsLicenseDto,
    @Req() request: { user: { userId: string } },
  ): Promise<RightsLicenseDetailDto> {
    return this.service.revoke(id, dto, request.user.userId);
  }

  @Post('licenses/:id/links')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Link a license to a rights entity' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 201, type: RightsLicenseLinkDto })
  link(
    @Param('id') id: string,
    @Body() dto: LinkRightsLicenseDto,
    @Req() request: { user: { userId: string } },
  ): Promise<RightsLicenseLinkDto> {
    return this.service.link(id, dto, request.user.userId);
  }

  @Delete('licenses/:id/links/:linkId')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Remove a license link (the license itself is preserved)' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'linkId' })
  @ApiResponse({ status: 200, type: UnlinkRightsLicenseResponseDto })
  unlink(
    @Param('id') id: string,
    @Param('linkId') linkId: string,
    @Req() request: { user: { userId: string } },
  ): Promise<UnlinkRightsLicenseResponseDto> {
    return this.service.unlink(id, linkId, request.user.userId);
  }

  @Get('profiles/:profileId/licenses')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'List licenses reachable from a rights profile' })
  @ApiParam({ name: 'profileId' })
  @ApiResponse({ status: 200, type: RightsLicenseListResponseDto })
  listForProfile(@Param('profileId') profileId: string): Promise<RightsLicenseListResponseDto> {
    return this.service.listForProfile(profileId);
  }

  @Get('profiles/:profileId/license-coverage')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Evaluate license coverage for a rights profile' })
  @ApiParam({ name: 'profileId' })
  @ApiResponse({ status: 200, type: LicenseCoverageResultDto })
  profileCoverage(@Param('profileId') profileId: string): Promise<LicenseCoverageResultDto> {
    return this.coverageService.evaluateProfileCoverage(profileId);
  }
}
