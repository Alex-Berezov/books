import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UpdateReadingProgressDto } from './dto/update-reading-progress.dto';
import { ReadingProgressService } from './reading-progress.service';
import { ReadingProgressDto } from './dto/reading-progress.dto';

interface RequestUser {
  userId: string;
  email: string;
}

@ApiTags('reading-progress')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class ReadingProgressController {
  constructor(private readonly service: ReadingProgressService) {}

  @Get('me/progress/:versionId')
  @ApiOperation({ summary: 'Get my reading/listening progress for a book version' })
  @ApiParam({ name: 'versionId' })
  @ApiOkResponse({ type: ReadingProgressDto })
  get(
    @Req() req: { user: RequestUser },
    @Param('versionId') versionId: string,
  ): ReturnType<ReadingProgressService['get']> {
    return this.service.get(req.user.userId, versionId);
  }

  @Put('me/progress/:versionId')
  @ApiOperation({ summary: 'Create or update my reading/listening progress for a book version' })
  @ApiParam({ name: 'versionId' })
  @ApiOkResponse({ type: ReadingProgressDto })
  upsert(
    @Req() req: { user: RequestUser },
    @Param('versionId') versionId: string,
    @Body() dto: UpdateReadingProgressDto,
  ): ReturnType<ReadingProgressService['upsert']> {
    return this.service.upsert(req.user.userId, versionId, dto);
  }
}
