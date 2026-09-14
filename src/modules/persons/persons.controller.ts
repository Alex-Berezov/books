import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CreatePersonDto } from './dto/create-person.dto';
import { PersonDetailDto } from './dto/person-response.dto';
import { QueryPersonsDto } from './dto/query-persons.dto';
import { UpdatePersonDto } from './dto/update-person.dto';
import { PersonsService } from './persons.service';
import { PaginationInfoDto, paginatedSchema } from '../../shared/dto/paginated-response.dto';

@ApiTags('admin/persons')
@ApiExtraModels(PersonDetailDto, PaginationInfoDto)
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin, Role.ContentManager)
@Controller('admin/persons')
export class PersonsController {
  constructor(private readonly personsService: PersonsService) {}

  @Get()
  @ApiOperation({ summary: 'Get list of persons with filters' })
  // Список отдаёт ту же строку, что и карточка: `findAll` грузит `include: { translations: true }`,
  // поэтому схемой стоит `PersonDetailDto`, а не базовый `PersonListItemDto` без переводов
  // (`LEGACY-016`, 14.09.2026 — расхождение вскрылось, как только тип возврата сервиса
  // перестал быть `Record<string, unknown>`).
  @ApiOkResponse({ schema: paginatedSchema(PersonDetailDto) })
  public async findAll(@Query() query: QueryPersonsDto) {
    return this.personsService.findAll(query);
  }

  @Get('search')
  @ApiOperation({ summary: 'Search persons by query' })
  @ApiOkResponse({ schema: paginatedSchema(PersonDetailDto) })
  public async search(@Query('q') q: string) {
    return this.personsService.search(q || '');
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get person details by ID' })
  @ApiResponse({ status: 200, type: PersonDetailDto })
  public async findOne(@Param('id') id: string) {
    return this.personsService.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create new person' })
  @ApiResponse({ status: 201, type: PersonDetailDto })
  public async create(@Body() dto: CreatePersonDto) {
    return this.personsService.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update person details' })
  @ApiResponse({ status: 200, type: PersonDetailDto })
  public async update(@Param('id') id: string, @Body() dto: UpdatePersonDto) {
    return this.personsService.update(id, dto);
  }
}
