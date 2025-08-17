import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { BookSummaryService } from './book-summary.service';
import { UpdateBookSummaryDto } from './dto/update-book-summary.dto';

@ApiTags('summaries')
@Controller()
export class BookSummaryController {
  constructor(private readonly service: BookSummaryService) {}

  @Get('versions/:bookVersionId/summary')
  @ApiOperation({ summary: 'Get book summary for a version' })
  @ApiParam({ name: 'bookVersionId' })
  get(@Param('bookVersionId') bookVersionId: string) {
    return this.service.getByVersion(bookVersionId);
  }

  @Put('versions/:bookVersionId/summary')
  @ApiOperation({ summary: 'Create or update summary for a version (upsert)' })
  @ApiParam({ name: 'bookVersionId' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  upsert(@Param('bookVersionId') bookVersionId: string, @Body() dto: UpdateBookSummaryDto) {
    return this.service.upsertForVersion(bookVersionId, dto);
  }
}
