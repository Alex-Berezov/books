import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PaginationInfoDto, paginatedSchema } from '../../shared/dto/paginated-response.dto';
import { RightsReviewImportService } from './rights-review-import.service';
import { CreateRightsReviewImportDto } from './dto/create-rights-review-import.dto';
import {
  ListRightsReviewImportsRequestDto,
  RightsReviewImportDetailDto,
  RightsReviewImportListItemDto,
  RightsReviewImportRecordDto,
} from './dto/rights-review-import-response.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';

@ApiTags('rights-review-imports')
@ApiExtraModels(RightsReviewImportListItemDto, PaginationInfoDto)
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin, Role.ContentManager)
export class RightsReviewImportController {
  constructor(private readonly service: RightsReviewImportService) {}

  @Post('admin/rights/intakes/:id/review-imports')
  @ApiOperation({ summary: 'Import a review result for a rights intake' })
  @ApiCreatedResponse({ type: RightsReviewImportRecordDto })
  create(
    @Param('id') id: string,
    @Body() dto: CreateRightsReviewImportDto,
    @Req() req: { user: { userId: string } },
  ) {
    return this.service.create(id, dto, req.user.userId);
  }

  @Get('admin/rights/intakes/:id/review-imports')
  @ApiOperation({ summary: 'List review imports for a rights intake' })
  @ApiOkResponse({ schema: paginatedSchema(RightsReviewImportListItemDto) })
  listByIntake(@Param('id') id: string, @Query() query: ListRightsReviewImportsRequestDto) {
    return this.service.listByIntake(id, query);
  }

  @Get('admin/rights/review-imports/:importId')
  @ApiOperation({ summary: 'Get a specific review import by ID' })
  @ApiOkResponse({ type: RightsReviewImportDetailDto })
  getById(@Param('importId') importId: string) {
    return this.service.getById(importId);
  }
}
