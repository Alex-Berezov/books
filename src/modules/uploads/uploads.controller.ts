import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Post,
  Query,
  Req,
  UseGuards,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, Role } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequiredStringPipe } from '../../common/pipes/required-string.pipe';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import {
  PresignRequestDto,
  PresignResponseDto,
  DirectUploadResponseDto,
  UploadType,
} from './dto/presign.dto';
import { UploadsService } from './uploads.service';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';

/**
 * ⚠️ `@Roles(Role.Admin, Role.ContentManager, Role.User)` на маршрутах ниже —
 * это «нужен вход», а не «нужна роль сотрудника»: `RolesGuard` добавляет
 * `Role.User` каждому (`roles.guard.ts`), поэтому предикат истинен для любого
 * прошедшего `JwtAuthGuard`. Состав ролей продиктован тем, что обложки кладут
 * обычные пользователи, и менять его — решение владельца продукта
 * (`LEGACY-110`).
 *
 * 🔴 Настоящая проверка прав на аудио — `isModerator` в теле обработчика. Снять
 * её как «дубль подключённого гварда» нельзя: `POST /uploads/presign` начнёт
 * выдавать подпись на аудио любому вошедшему.
 */
@ApiTags('Uploads')
@Controller('uploads')
export class UploadsController {
  constructor(
    private readonly uploads: UploadsService,
    private readonly moderatorRoles: ModeratorRolesService,
  ) {}

  @ApiOperation({
    summary: 'Public upload limits (max size, allowed content types)',
  })
  @Get('limits')
  limits() {
    return this.uploads.getLimits();
  }

  @ApiOperation({ summary: 'Get a presigned direct-upload token and URL' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RateLimitGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager, Role.User)
  @Post('presign')
  async presign(@Body() dto: PresignRequestDto, @Req() req: Request): Promise<PresignResponseDto> {
    const typedReq = req as Request & { user?: { userId: string; email: string } };
    const userId = typedReq.user?.userId;
    const email = typedReq.user?.email;
    if (!userId || !email) throw new UnauthorizedException();

    if (dto.type === UploadType.audio) {
      const isStaff = await this.moderatorRoles.isModerator({ userId, email });
      if (!isStaff)
        throw new ForbiddenException('Only admin or content_manager can upload audio files');
    }

    return this.uploads.presign(dto, String(userId));
  }

  @ApiOperation({ summary: 'Direct binary upload by token (local driver)' })
  @ApiBody({ description: 'Binary file body' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @Post('direct')
  async direct(
    @Headers('x-upload-token') token: string,
    @Req() req: Request,
  ): Promise<DirectUploadResponseDto> {
    const typedReq = req as Request & { user?: { userId: string } };
    const userId = typedReq.user?.userId;
    if (!userId) throw new UnauthorizedException();
    // express.raw middleware attaches Buffer as req.body in our config; fallback to empty buffer
    const buf = (req.body as Buffer) || Buffer.from([]);
    const contentType = req.headers['content-type'] || 'application/octet-stream';
    return this.uploads.directUpload(token, buf, String(contentType), String(userId));
  }

  @ApiOperation({ summary: 'Confirm an uploaded object and return its public URL' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager, Role.User)
  @Post('confirm')
  async confirm(
    @Query('key', RequiredStringPipe) key: string,
    @Req() req: Request,
  ): Promise<DirectUploadResponseDto> {
    const typedReq = req as Request & { user?: { userId: string; email: string } };
    const userId = typedReq.user?.userId;
    const email = typedReq.user?.email;
    if (!userId || !email) throw new UnauthorizedException();

    if (!key.startsWith('covers/')) {
      const isStaff = await this.moderatorRoles.isModerator({ userId, email });
      if (!isStaff)
        throw new ForbiddenException('Only admin or content_manager can confirm audio assets');
    }

    const url = this.uploads.getPublicUrl(key);
    return { key, publicUrl: url };
  }

  @ApiOperation({ summary: 'Delete uploaded object by key' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager, Role.User)
  @Delete()
  async delete(@Query('key', RequiredStringPipe) key: string, @Req() req: Request): Promise<void> {
    const typedReq = req as Request & { user?: { userId: string; email: string } };
    const userId = typedReq.user?.userId;
    const email = typedReq.user?.email;
    if (!userId || !email) throw new UnauthorizedException();

    if (!key.startsWith('covers/')) {
      const isStaff = await this.moderatorRoles.isModerator({ userId, email });
      if (!isStaff)
        throw new ForbiddenException('Only admin or content_manager can delete audio assets');
    }

    await this.uploads.delete(key);
  }
}
