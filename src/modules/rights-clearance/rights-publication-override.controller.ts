import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  GrantRightsPublicationOverrideDto,
  RevokeRightsPublicationOverrideDto,
  RightsPublicationOverrideDto,
  RightsPublicationOverrideStateDto,
} from './dto/rights-publication-override.dto';
import { RightsPublicationOverrideService } from './rights-publication-override.service';

@ApiTags('rights-override')
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin, Role.ContentManager)
@ApiBearerAuth()
export class RightsPublicationOverrideController {
  constructor(private readonly overrides: RightsPublicationOverrideService) {}

  @Get('admin/books/:bookId/rights-override')
  @ApiOperation({
    summary: 'Действующее решение «Разрешить публикацию» и история решений по книге',
  })
  @ApiOkResponse({ type: RightsPublicationOverrideStateDto })
  getState(@Param('bookId') bookId: string): Promise<RightsPublicationOverrideStateDto> {
    return this.overrides.getState(bookId);
  }

  @Post('admin/books/:bookId/rights-override')
  @Roles(Role.Admin)
  @ApiOperation({
    summary:
      'Разрешить публикацию: снять все правовые ограничения с книги (последняя инстанция, только admin)',
  })
  @ApiCreatedResponse({ type: RightsPublicationOverrideDto })
  grant(
    @Param('bookId') bookId: string,
    @Body() dto: GrantRightsPublicationOverrideDto,
    @Req() req: { user: { userId: string } },
  ): Promise<RightsPublicationOverrideDto> {
    return this.overrides.grant(bookId, dto.reasonRu, req.user.userId);
  }

  @Post('admin/books/:bookId/rights-override/revoke')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.Admin)
  @ApiOperation({ summary: 'Отменить действующее решение «Разрешить публикацию» (только admin)' })
  @ApiOkResponse({ type: RightsPublicationOverrideDto })
  @ApiConflictResponse({ description: 'RIGHTS_OVERRIDE_NOT_ACTIVE — действующего решения нет' })
  revoke(
    @Param('bookId') bookId: string,
    @Body() dto: RevokeRightsPublicationOverrideDto,
    @Req() req: { user: { userId: string } },
  ): Promise<RightsPublicationOverrideDto> {
    return this.overrides.revoke(bookId, dto.reasonRu, req.user.userId);
  }
}
