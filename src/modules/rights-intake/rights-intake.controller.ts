import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RightsIntakeService } from './rights-intake.service';
import { RightsIntakeManifestService } from './rights-intake-manifest.service';
import { CreateRightsIntakeDto } from './dto/create-rights-intake.dto';
import { UpdateRightsIntakeDto } from './dto/update-rights-intake.dto';
import { ListRightsIntakesDto } from './dto/list-rights-intakes.dto';
import { ChangeRightsIntakeStatusDto } from './dto/change-rights-intake-status.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';

@ApiTags('rights-intakes')
@Controller('admin/rights/intakes')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin, Role.ContentManager)
export class RightsIntakeController {
  constructor(
    private readonly service: RightsIntakeService,
    private readonly manifestService: RightsIntakeManifestService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List rights intakes' })
  list(@Query() dto: ListRightsIntakesDto) {
    return this.service.list(dto);
  }

  @Post()
  @ApiOperation({ summary: 'Create rights intake' })
  create(@Body() dto: CreateRightsIntakeDto, @Req() req: { user: { userId: string } }) {
    return this.service.create(dto, req.user.userId);
  }

  @Get(':id/agent-manifest')
  @ApiOperation({ summary: 'Export agent manifest for external ChatGPT-based rights check' })
  agentManifest(@Param('id') id: string) {
    return this.manifestService.generate(id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get rights intake by ID' })
  getById(@Param('id') id: string) {
    return this.service.getById(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update rights intake' })
  update(@Param('id') id: string, @Body() dto: UpdateRightsIntakeDto) {
    return this.service.update(id, dto);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Change rights intake status' })
  changeStatus(@Param('id') id: string, @Body() dto: ChangeRightsIntakeStatusDto) {
    return this.service.changeStatus(id, dto.status);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive rights intake (soft delete)' })
  archive(@Param('id') id: string) {
    return this.service.archive(id);
  }
}
