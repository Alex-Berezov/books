import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Role, Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { AcceptWorldImageDto } from '../dto/world-image-request.dto';
import { WorldImageStateDto } from '../dto/world-image-response.dto';
import { WorldImageService } from './world-image.service';

/**
 * Иллюстрация героя во вкладке World (`F08-11a`, решения арбитра `F08 | F08-11`): всё - только
 * `admin` (Р5: генерация - деньги, принятие - решение администратора, `product.md` §8, §17 п.7).
 * Читатель видит картинку только полем `image` страницы сущности - после «Accept».
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
@Controller('admin')
export class WorldImageController {
  constructor(private readonly images: WorldImageService) {}

  @Get('versions/:id/world/:key/image')
  @ApiOperation({
    summary:
      'Illustration of a world entity: accepted (shown on the site), pending (generated, waiting for Accept) and the latest generation',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'key' })
  @ApiOkResponse({ type: WorldImageStateDto })
  @ApiNotFoundResponse({ description: 'No such entity in the version' })
  state(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('key') key: string,
  ): Promise<WorldImageStateDto> {
    return this.images.state(id, key);
  }

  @Post('versions/:id/world/:key/image')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Generate (or regenerate) the illustration of a main or secondary character in the background from its appearance text; the result becomes pending, the accepted one stays on the site until Accept',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'key' })
  @ApiAcceptedResponse({ type: WorldImageStateDto })
  @ApiNotFoundResponse({ description: 'No such entity in the version' })
  @ApiConflictResponse({
    description:
      'WORLD_IMAGE_IN_PROGRESS - a generation is running (a paused one is cancelled and replaced); WORLD_IMAGE_NOT_ALLOWED - not a main or secondary character; WORLD_IMAGE_NO_APPEARANCE - no appearance text; LLM_CEILING_REACHED',
  })
  generate(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('key') key: string,
    @Req() req: { user: { userId: string } },
  ): Promise<WorldImageStateDto> {
    return this.images.generate(id, key, req.user.userId);
  }

  @Post('versions/:id/world/:key/image/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Accept the pending illustration: it replaces the accepted one on the site for every language of the book',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'key' })
  @ApiOkResponse({ type: WorldImageStateDto })
  @ApiNotFoundResponse({ description: 'No such entity in the version' })
  @ApiConflictResponse({
    description:
      'WORLD_IMAGE_NONE - nothing to accept (or its file was deleted); WORLD_IMAGE_CHANGED - the pending image is not the one sent; WORLD_IMAGE_NOT_ALLOWED - the entity is no longer a main or secondary character',
  })
  accept(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('key') key: string,
    @Body() dto: AcceptWorldImageDto,
  ): Promise<WorldImageStateDto> {
    return this.images.accept(id, key, dto.pendingMediaId);
  }
}
