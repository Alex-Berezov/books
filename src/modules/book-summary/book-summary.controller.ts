import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { BookSummaryService } from './book-summary.service';
import { UpdateBookSummaryDto } from './dto/update-book-summary.dto';
import { BookSummaryResponseDto } from './dto/book-summary-response.dto';

@ApiTags('summaries')
@Controller()
export class BookSummaryController {
  constructor(private readonly service: BookSummaryService) {}

  @Get('versions/:bookVersionId/summary')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get book summary for a version (drafts are visible to editors only)',
  })
  // Тело ответа может отсутствовать: `getByVersion` заканчивается `findFirst` и отдаёт `null`,
  // если у версии нет пересказа (`book-summary.service.ts`). `type: BookSummaryResponseDto`
  // обещал бы объект всегда, и клиент по схеме не знал бы про пустую ветку.
  @ApiExtraModels(BookSummaryResponseDto)
  @ApiOkResponse({
    schema: { allOf: [{ $ref: getSchemaPath(BookSummaryResponseDto) }], nullable: true },
    description: 'Summary, or null when the version has none',
  })
  @ApiParam({ name: 'bookVersionId' })
  get(
    @Param('bookVersionId') bookVersionId: string,
    @Req() req?: { user?: { userId: string; email: string } },
  ) {
    return this.service.getByVersion(bookVersionId, req?.user);
  }

  @Put('versions/:bookVersionId/summary')
  @ApiOperation({ summary: 'Create or update summary for a version (upsert)' })
  @ApiOkResponse({ type: BookSummaryResponseDto })
  @ApiParam({ name: 'bookVersionId' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  upsert(@Param('bookVersionId') bookVersionId: string, @Body() dto: UpdateBookSummaryDto) {
    return this.service.upsertForVersion(bookVersionId, dto);
  }
}
