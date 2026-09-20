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
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiExtraModels,
} from '@nestjs/swagger';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ContributorsService } from './contributors.service';
import { CreateContributorDto } from './dto/create-contributor.dto';
import { LinkRightsComponentContributorDto } from './dto/link-rights-component-contributor.dto';
import { LinkSourceEditionContributorDto } from './dto/link-source-edition-contributor.dto';
import { QueryContributorsDto } from './dto/query-contributors.dto';
import { UpdateContributorDto } from './dto/update-contributor.dto';
import { ContributorLinkResponseDto, ContributorResponseDto } from './dto/contributor-response.dto';
import { DeleteContributorResponseDto } from './dto/delete-contributor-response.dto';
import { PaginationInfoDto, paginatedSchema } from '../../shared/dto/paginated-response.dto';

/**
 * Форма пользователя запроса — та же, что в остальных контроллерах
 * (`STYLE_GUIDE.md`, раздел «Контроллеры»). Общего `@CurrentUser()` в проекте
 * нет вовсе, и сведение копий к одному декоратору — отдельная работа,
 * записанная строкой в теле `LEGACY-015`.
 *
 * ⚠️ Заведён под путь журнала (`DELETE admin/contributors/:id`). Пять соседних
 * обработчиков этого файла по-прежнему типизируют `@Req()` встроенным литералом:
 * перевод их всех — попутный рефакторинг вне границ записи. Но копии актёра
 * считаются машинно (`grep -rl "^interface RequestUser" src`), и анонимная форма
 * в этот счёт не попадает — значит путь журнала остался бы вне будущей замены
 * на общий `@CurrentUser()`.
 */
interface RequestUser {
  userId: string;
  email: string;
}

@ApiTags('Contributors')
@ApiExtraModels(ContributorResponseDto, PaginationInfoDto)
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class ContributorsController {
  constructor(private readonly contributorsService: ContributorsService) {}

  @Get('contributors')
  @ApiOkResponse({ schema: paginatedSchema(ContributorResponseDto) })
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'List contributors with search and filters' })
  async findAll(@Query() query: QueryContributorsDto) {
    return this.contributorsService.findAll(query);
  }

  @Post('contributors')
  @ApiCreatedResponse({ type: ContributorResponseDto })
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Create a new contributor' })
  async create(@Body() dto: CreateContributorDto) {
    return this.contributorsService.create(dto);
  }

  @Get('contributors/:id')
  @ApiOkResponse({ type: ContributorResponseDto })
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Get contributor detail by ID' })
  async findOne(@Param('id') id: string) {
    return this.contributorsService.findOne(id);
  }

  @Patch('contributors/:id')
  @ApiOkResponse({ type: ContributorResponseDto })
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Update contributor details' })
  async update(@Param('id') id: string, @Body() dto: UpdateContributorDto) {
    return this.contributorsService.update(id, dto);
  }

  @Delete('contributors/:id')
  @ApiOkResponse({ type: DeleteContributorResponseDto })
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Delete a contributor' })
  async remove(
    @Param('id') id: string,
    @Req() request: { user: RequestUser },
  ): Promise<{ id: string }> {
    // Актёр берётся из запроса, а не из тела: журнал должен отвечать «кто»,
    // а не «кто представился» (`LEGACY-015`).
    return this.contributorsService.remove(id, request.user.userId);
  }

  @Post('source-editions/:id/contributors')
  @ApiCreatedResponse({ type: ContributorLinkResponseDto })
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Link contributor to a source edition' })
  async linkSourceEdition(
    @Param('id') sourceEditionId: string,
    @Body() dto: LinkSourceEditionContributorDto,
    @Req() request: { user: { userId: string } },
  ) {
    return this.contributorsService.linkSourceEdition(sourceEditionId, dto, request.user.userId);
  }

  @Delete('source-editions/:id/contributors/:linkId')
  @ApiOkResponse({ type: ContributorLinkResponseDto })
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Unlink contributor from a source edition' })
  async unlinkSourceEdition(
    @Param('id') sourceEditionId: string,
    @Param('linkId') linkId: string,
    @Req() request: { user: { userId: string } },
  ) {
    return this.contributorsService.unlinkSourceEdition(
      sourceEditionId,
      linkId,
      request.user.userId,
    );
  }

  @Post('rights-components/:id/contributors')
  @ApiCreatedResponse({ type: ContributorLinkResponseDto })
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Link contributor to a rights component' })
  async linkRightsComponent(
    @Param('id') rightsComponentId: string,
    @Body() dto: LinkRightsComponentContributorDto,
    @Req() request: { user: { userId: string } },
  ) {
    return this.contributorsService.linkRightsComponent(
      rightsComponentId,
      dto,
      request.user.userId,
    );
  }

  @Delete('rights-components/:id/contributors/:linkId')
  @ApiOkResponse({ type: ContributorLinkResponseDto })
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Unlink contributor from a rights component' })
  async unlinkRightsComponent(
    @Param('id') rightsComponentId: string,
    @Param('linkId') linkId: string,
    @Req() request: { user: { userId: string } },
  ) {
    return this.contributorsService.unlinkRightsComponent(
      rightsComponentId,
      linkId,
      request.user.userId,
    );
  }
}
