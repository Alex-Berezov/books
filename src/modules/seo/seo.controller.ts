import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { SeoService } from './seo.service';
import { UpdateSeoDto } from './dto/update-seo.dto';

@ApiTags('seo')
@Controller()
export class SeoController {
  constructor(private readonly service: SeoService) {}

  @Get('versions/:bookVersionId/seo')
  @ApiOperation({ summary: 'Get SEO meta for a book version' })
  @ApiParam({ name: 'bookVersionId' })
  get(@Param('bookVersionId') bookVersionId: string) {
    return this.service.getByVersion(bookVersionId);
  }

  @Put('versions/:bookVersionId/seo')
  @ApiOperation({ summary: 'Create or update SEO meta for a book version (upsert)' })
  @ApiParam({ name: 'bookVersionId' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  upsert(@Param('bookVersionId') bookVersionId: string, @Body() dto: UpdateSeoDto) {
    return this.service.upsertForVersion(bookVersionId, dto);
  }
}
