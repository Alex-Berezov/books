import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
  Req,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { MediaService } from './media.service';
import { ConfirmMediaDto, MediaListQueryDto } from './dto/create-media.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, Role } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Request } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { promises as fs } from 'node:fs';
import { memoryStorage } from 'multer';
import { UploadsService } from '../uploads/uploads.service';
import { PresignRequestDto, UploadType } from '../uploads/dto/presign.dto';

type UploadedFileType = { buffer?: Buffer; mimetype?: string; size?: number; path?: string };

@ApiTags('media')
@Controller()
export class MediaController {
  constructor(
    private readonly service: MediaService,
    private readonly uploads: UploadsService,
  ) {}

  @Post('media/confirm')
  @ApiOperation({ summary: 'Confirm uploaded object and create/update MediaAsset' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  confirm(@Body() dto: ConfirmMediaDto, @Req() req: Request) {
    const typed = req as Request & { user?: { userId: string } };
    const userId = typed.user?.userId as string;
    return this.service.confirm(dto, userId);
  }

  @Get('media')
  @ApiOperation({ summary: 'List media assets' })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'type', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  list(@Query() query: MediaListQueryDto) {
    return this.service.list(query);
  }

  @Post('media/upload')
  @ApiOperation({
    summary: 'One-step upload: multipart file -> presign -> direct -> media.confirm',
  })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        type: { type: 'string', enum: ['cover', 'audio'] },
      },
      required: ['file'],
    },
  })
  @UseInterceptors(
    FileInterceptor(
      'file',
      ((): MulterOptions => ({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        storage: memoryStorage(),
        limits: { fileSize: 110 * 1024 * 1024 }, // ~110MB, как в /uploads/direct
      }))(),
    ),
  )
  async uploadOne(
    @UploadedFile() file: UploadedFileType,
    @Body('type') type: UploadType = UploadType.cover,
    @Req() req: Request,
  ) {
    const typed = req as Request & { user?: { userId: string } };
    const userId = typed.user?.userId as string;
    if (!file) throw new BadRequestException('file is required');
    const ct = file.mimetype || 'application/octet-stream';
    const size = Number(file.size || 0);
    // Получаем буфер: либо из memoryStorage, либо читаем с диска (если Multer сохранил во временный файл)
    let buf: Buffer;
    if (file.buffer && Buffer.isBuffer(file.buffer)) {
      buf = file.buffer;
    } else if (file.path) {
      buf = await fs.readFile(file.path);
    } else {
      throw new BadRequestException('Unable to read uploaded file');
    }
    // 1) presign
    const presignDto: PresignRequestDto = {
      type,
      contentType: ct,
      size,
    } as PresignRequestDto;
    const pres = await this.uploads.presign(presignDto, userId);
    // 2) direct (using in-memory buffer)
    const direct = await this.uploads.directUpload(pres.token, buf, ct, userId);
    // 3) media.confirm
    const asset = await this.service.confirm(
      {
        key: pres.key,
        url: direct.publicUrl,
        contentType: ct,
        size,
      },
      userId,
    );
    // Best-effort cleanup временного файла, если он создавался на диске
    try {
      if (file.path) await fs.unlink(file.path);
    } catch {
      // ignore
    }
    return asset;
  }

  @Delete('media/:id')
  @ApiOperation({ summary: 'Soft-delete media asset and try to remove file' })
  @ApiParam({ name: 'id' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
