import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  LlmBudgetResponseDto,
  LlmModelDto,
  LlmStageSettingDto,
  LlmStatusResponseDto,
} from './dto/llm-response.dto';
import { UpdateLlmBudgetDto } from './dto/update-llm-budget.dto';
import { UpdateLlmStageSettingDto } from './dto/update-llm-stage-setting.dto';
import {
  PaginationInfoDto,
  paginatedAll,
  paginatedSchema,
} from '../../shared/dto/paginated-response.dto';
import { LlmService } from './llm.service';

interface RequestUser {
  userId: string;
  email: string;
}

/**
 * Настройки LLM-конвейера - только `admin` (U6): модели этапов, потолок расходов и состояние
 * ключа. Ни одна ручка здесь модель не зовёт и денег не тратит (Р25).
 */
@ApiTags('admin')
@ApiExtraModels(LlmModelDto, LlmStageSettingDto, PaginationInfoDto)
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
@Controller('admin/llm')
export class LlmController {
  constructor(private readonly llm: LlmService) {}

  @Get('status')
  @ApiOperation({
    summary: 'LLM module state: whether the key is configured, ceiling, spent and reserved',
  })
  @ApiOkResponse({ type: LlmStatusResponseDto })
  getStatus() {
    return this.llm.status();
  }

  @Get('models')
  @ApiOperation({
    summary: 'OpenRouter models with prices per million tokens (cached for an hour)',
  })
  // Весь каталог одной страницей: выпадающему списку экрана нужен он целиком (решение
  // арбитра `F05 | F05-1`, форма списков).
  @ApiOkResponse({ schema: paginatedSchema(LlmModelDto) })
  async listModels() {
    return paginatedAll(await this.llm.listModels());
  }

  @Get('stage-settings')
  @ApiOperation({ summary: 'Model settings of every registered pipeline stage' })
  @ApiOkResponse({ schema: paginatedSchema(LlmStageSettingDto) })
  async listStageSettings() {
    return paginatedAll(await this.llm.listStageSettings());
  }

  @Put('stage-settings/:stage')
  @ApiOperation({
    summary:
      'Change the model of a stage without a deploy; models must be in the OpenRouter list and priced or capped by maxPricePerMTok',
  })
  @ApiParam({ name: 'stage' })
  @ApiOkResponse({ type: LlmStageSettingDto })
  updateStageSetting(
    @Param('stage') stage: string,
    @Body() dto: UpdateLlmStageSettingDto,
    @Req() req: { user: RequestUser },
  ) {
    return this.llm.updateStageSetting(stage, dto, req.user.userId);
  }

  @Put('budget')
  @ApiOperation({
    summary: 'Set the spending ceiling and the default run limit; ceilingUsd 0 stops every call',
  })
  @ApiOkResponse({ type: LlmBudgetResponseDto })
  updateBudget(@Body() dto: UpdateLlmBudgetDto, @Req() req: { user: RequestUser }) {
    return this.llm.updateBudget(dto, req.user.userId);
  }
}
