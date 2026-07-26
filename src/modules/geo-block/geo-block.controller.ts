import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  CheckGeoBlockAccessDto,
  GeoAccessCheckResultDto,
  GeoBlockRulesResponseDto,
  VerifyGeoBlockRulesDto,
} from './dto/geo-block.dto';
import { GeoBlockRuleService } from './geo-block-rule.service';

@ApiTags('geo-block')
@ApiBearerAuth()
@Controller('admin/versions/:id')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin, Role.ContentManager)
export class GeoBlockController {
  constructor(private readonly service: GeoBlockRuleService) {}

  @Get('geo-block-rules')
  @ApiOperation({ summary: 'List generated geo-block rules for a book version' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: GeoBlockRulesResponseDto })
  getRules(@Param('id') id: string): Promise<GeoBlockRulesResponseDto> {
    return this.service.getRulesForVersion(id);
  }

  @Post('geo-block-rules/generate')
  @ApiOperation({ summary: 'Generate runtime rules from country-level territory decisions' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 201, type: GeoBlockRulesResponseDto })
  generateRules(@Param('id') id: string): Promise<GeoBlockRulesResponseDto> {
    return this.service.generateRulesForVersion(id);
  }

  @Post('geo-block-rules/verify')
  @ApiOperation({ summary: 'Verify generated geo-block rules and enable publication gate state' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 201, type: GeoBlockRulesResponseDto })
  verifyRules(
    @Param('id') id: string,
    @Body() dto: VerifyGeoBlockRulesDto,
    @Req() request: { user: { userId: string } },
  ): Promise<GeoBlockRulesResponseDto> {
    return this.service.verifyRulesForVersion(id, dto, request.user.userId);
  }

  @Post('geo-block-check')
  @ApiOperation({ summary: 'Test runtime access for a country and content scope' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 201, type: GeoAccessCheckResultDto })
  checkAccess(
    @Param('id') id: string,
    @Body() dto: CheckGeoBlockAccessDto,
  ): Promise<GeoAccessCheckResultDto> {
    return this.service.checkAccess({
      bookVersionId: id,
      countryCode: dto.countryCode,
      scope: dto.scope,
    });
  }
}
