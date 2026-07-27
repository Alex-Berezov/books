import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CreatePersonDto } from './dto/create-person.dto';
import { PersonDetailDto, PersonListResponseDto } from './dto/person-response.dto';
import { QueryPersonsDto } from './dto/query-persons.dto';
import { UpdatePersonDto } from './dto/update-person.dto';
import { PersonsService } from './persons.service';

@ApiTags('admin/persons')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin, Role.ContentManager)
@Controller('admin/persons')
export class PersonsController {
  constructor(private readonly personsService: PersonsService) {}

  @Get()
  @ApiOperation({ summary: 'Get list of persons with filters' })
  @ApiResponse({ status: 200, type: PersonListResponseDto })
  public async findAll(@Query() query: QueryPersonsDto) {
    return this.personsService.findAll(query);
  }

  @Get('search')
  @ApiOperation({ summary: 'Search persons by query' })
  @ApiResponse({ status: 200, type: PersonListResponseDto })
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
