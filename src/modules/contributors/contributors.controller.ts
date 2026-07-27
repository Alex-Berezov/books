import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ContributorsService } from './contributors.service';
import { CreateContributorDto } from './dto/create-contributor.dto';
import { LinkRightsComponentContributorDto } from './dto/link-rights-component-contributor.dto';
import { LinkSourceEditionContributorDto } from './dto/link-source-edition-contributor.dto';
import { QueryContributorsDto } from './dto/query-contributors.dto';
import { UpdateContributorDto } from './dto/update-contributor.dto';

@ApiTags('Contributors')
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class ContributorsController {
  constructor(private readonly contributorsService: ContributorsService) {}

  @Get('contributors')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'List contributors with search and filters' })
  async findAll(@Query() query: QueryContributorsDto) {
    return this.contributorsService.findAll(query);
  }

  @Post('contributors')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Create a new contributor' })
  async create(@Body() dto: CreateContributorDto) {
    return this.contributorsService.create(dto);
  }

  @Get('contributors/:id')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Get contributor detail by ID' })
  async findOne(@Param('id') id: string) {
    return this.contributorsService.findOne(id);
  }

  @Patch('contributors/:id')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Update contributor details' })
  async update(@Param('id') id: string, @Body() dto: UpdateContributorDto) {
    return this.contributorsService.update(id, dto);
  }

  @Delete('contributors/:id')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Delete a contributor' })
  async remove(@Param('id') id: string) {
    return this.contributorsService.remove(id);
  }

  @Post('source-editions/:id/contributors')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Link contributor to a source edition' })
  async linkSourceEdition(
    @Param('id') sourceEditionId: string,
    @Body() dto: LinkSourceEditionContributorDto,
  ) {
    return this.contributorsService.linkSourceEdition(sourceEditionId, dto);
  }

  @Delete('source-editions/:id/contributors/:linkId')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Unlink contributor from a source edition' })
  async unlinkSourceEdition(@Param('id') sourceEditionId: string, @Param('linkId') linkId: string) {
    return this.contributorsService.unlinkSourceEdition(sourceEditionId, linkId);
  }

  @Post('rights-components/:id/contributors')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Link contributor to a rights component' })
  async linkRightsComponent(
    @Param('id') rightsComponentId: string,
    @Body() dto: LinkRightsComponentContributorDto,
  ) {
    return this.contributorsService.linkRightsComponent(rightsComponentId, dto);
  }

  @Delete('rights-components/:id/contributors/:linkId')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Unlink contributor from a rights component' })
  async unlinkRightsComponent(
    @Param('id') rightsComponentId: string,
    @Param('linkId') linkId: string,
  ) {
    return this.contributorsService.unlinkRightsComponent(rightsComponentId, linkId);
  }
}
