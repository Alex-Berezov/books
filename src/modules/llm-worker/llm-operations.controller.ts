import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { LlmOperationDto } from './dto/llm-operation.dto';
import { ResumeLlmOperationDto } from './dto/resume-llm-operation.dto';
import { LlmOperationsService } from './llm-operations.service';

/** Операции LLM-конвейера - только `admin` (U6). Отмена останавливает траты операции. */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
@Controller('admin/llm/operations')
export class LlmOperationsController {
  constructor(private readonly operations: LlmOperationsService) {}

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel an active or paused LLM operation: pending tasks stop, nothing more is spent',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: LlmOperationDto })
  @ApiConflictResponse({ description: 'LLM_OPERATION_NOT_CANCELLABLE: already finished' })
  cancel(@Param('id') id: string): Promise<LlmOperationDto> {
    return this.operations.cancel(id);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resume a paused LLM operation from its next step, optionally with a new limit',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: LlmOperationDto })
  @ApiConflictResponse({
    description: 'LLM_OPERATION_NOT_RESUMABLE: not paused, or its kind cannot resume',
  })
  @ApiBadRequestResponse({ description: 'limitUsd below spent + reserved' })
  resume(@Param('id') id: string, @Body() dto: ResumeLlmOperationDto): Promise<LlmOperationDto> {
    return this.operations.resume(
      id,
      dto.limitUsd != null ? new Prisma.Decimal(dto.limitUsd) : undefined,
    );
  }
}
