import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { GeoCountrySourceHealthDto } from './dto/geo-block.dto';
import { GeoIpCountryService } from './geo-ip-country.service';

@ApiTags('geo-block')
@ApiBearerAuth()
@Controller('admin/geo-block')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin, Role.ContentManager)
export class GeoCountrySourceController {
  constructor(private readonly geoIpCountryService: GeoIpCountryService) {}

  @Get('country-source')
  @ApiOperation({
    summary: 'Health of the GeoIP country source (Phase 12 depends on an upstream proxy header)',
  })
  @ApiOkResponse({ type: GeoCountrySourceHealthDto })
  getCountrySource(): GeoCountrySourceHealthDto {
    return this.geoIpCountryService.getSourceHealth();
  }
}
