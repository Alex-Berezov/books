import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { ImportService } from './import.service';
import { ImportCategoryDto } from './dto/import-category.dto';
import { ImportTagDto } from './dto/import-tag.dto';

@ApiTags('import')
@Controller('import')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin, Role.ContentManager)
export class ImportController {
  constructor(private readonly service: ImportService) {}

  @Post('categories')
  @ApiOperation({ summary: 'Import categories/genres/collections from JSON' })
  @ApiBody({ type: [ImportCategoryDto] })
  @ApiResponse({ status: 201, description: 'Import results with counts' })
  importCategories(@Body() dto: ImportCategoryDto[]) {
    return this.service.importCategories(dto);
  }

  @Post('tags')
  @ApiOperation({ summary: 'Import tags from JSON' })
  @ApiBody({ type: [ImportTagDto] })
  @ApiResponse({ status: 201, description: 'Import results with counts' })
  importTags(@Body() dto: ImportTagDto[]) {
    return this.service.importTags(dto);
  }
}
