import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { BookSummaryService } from './book-summary.service';
import { UpdateBookSummaryDto } from './dto/update-book-summary.dto';

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
  @ApiParam({ name: 'bookVersionId' })
  get(
    @Param('bookVersionId') bookVersionId: string,
    @Req() req?: { user?: { userId: string; email: string } },
  ) {
    return this.service.getByVersion(bookVersionId, req?.user);
  }

  @Put('versions/:bookVersionId/summary')
  @ApiOperation({ summary: 'Create or update summary for a version (upsert)' })
  @ApiParam({ name: 'bookVersionId' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  upsert(@Param('bookVersionId') bookVersionId: string, @Body() dto: UpdateBookSummaryDto) {
    return this.service.upsertForVersion(bookVersionId, dto);
  }
}
