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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Role, Roles } from '../../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { FormFileInterceptor } from '../../../common/interceptors/form-file.interceptor';
import { AcceptWorldImageDto } from '../dto/world-image-request.dto';
import { WorldImageStateDto } from '../dto/world-image-response.dto';
import {
  WORLD_IMAGE_LIMITS,
  WORLD_IMAGE_TOO_LARGE,
  WORLD_IMAGE_UPLOAD_FIELD,
} from './world-image.constants';
import { WorldImageService } from './world-image.service';

/** Текстовых полей у формы загрузки нет: клиент шлёт один файл. */
const UPLOAD_FORM_FIELDS = 0;

// Как в соседних контроллерах модуля (`compare.controller.ts`): общего типа актёра нет (`LEGACY-015`).
interface RequestUser {
  userId: string;
}

/**
 * Иллюстрация героя во вкладке World (`F08-11a`, решения арбитра `F08 | F08-11`): всё - только
 * `admin` (Р5: принятие - решение администратора, `product.md` §8, §17 п.7). Генерации моделью нет
 * (`F08-11d-1`, решение владельца): ручки запуска генерации нет; файл делает владелец вручную и
 * загружает его здесь (`F08-11d-3`, решение арбитра `F08 | F08-11d` Q6).
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
      'Illustration of a world entity: accepted (shown on the site) and pending (waiting for Accept)',
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
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Upload the illustration file into the pending cell (the accepted one stays until Accept)',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiParam({ name: 'key' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiOkResponse({ type: WorldImageStateDto })
  @ApiNotFoundResponse({ description: 'No such entity in the version' })
  @ApiBadRequestResponse({
    description:
      'No file, a broken form, or a refused file: WORLD_IMAGE_NOT_IMAGE (not PNG, JPEG or WEBP by signature), WORLD_IMAGE_TOO_LARGE (over 40 Mpx), WORLD_IMAGE_TOO_SMALL (a character: a side under 1200 px; a place: width under 1200 or height under 675 px)',
  })
  @ApiPayloadTooLargeResponse({ description: 'WORLD_IMAGE_TOO_LARGE - the file is over 12 MB' })
  @ApiConflictResponse({
    description:
      'WORLD_IMAGE_NOT_ALLOWED - the entity is not a main or secondary character and not a place; WORLD_IMAGE_KEY_CONFLICT - the image row of this key belongs to an entity of another type that still has the right to it and a live file; WORLD_IMAGE_ENTITY_CHANGED - the entity type changed meanwhile (checked under the row lock, after the file check)',
  })
  @UseInterceptors(
    FormFileInterceptor(WORLD_IMAGE_UPLOAD_FIELD, WORLD_IMAGE_LIMITS.maxBytes, UPLOAD_FORM_FIELDS, {
      fileTooLargeCode: WORLD_IMAGE_TOO_LARGE,
    }),
  )
  upload(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('key') key: string,
    @UploadedFile() file: { buffer?: Buffer } | undefined,
    @Req() req: { user: RequestUser },
  ): Promise<WorldImageStateDto> {
    return this.images.upload(id, key, file?.buffer, req.user.userId);
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
      'Checked in this order: WORLD_IMAGE_NOT_ALLOWED - the entity is not a main or secondary character and not a place; then under the row lock WORLD_IMAGE_ENTITY_CHANGED - the entity type changed meanwhile, WORLD_IMAGE_NOT_ALLOWED - the right was lost meanwhile, WORLD_IMAGE_KEY_CONFLICT - the image row of this key belongs to an entity of another type that still has the right to it and a live file; then WORLD_IMAGE_NONE - nothing to accept (or its file was deleted); WORLD_IMAGE_CHANGED - the pending image is not the one sent',
  })
  accept(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('key') key: string,
    @Body() dto: AcceptWorldImageDto,
  ): Promise<WorldImageStateDto> {
    return this.images.accept(id, key, dto.pendingMediaId);
  }
}
