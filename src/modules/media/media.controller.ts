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
import { UploadsService } from '../uploads/uploads.service';
import { PresignRequestDto, UploadType } from '../uploads/dto/presign.dto';

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
  @UseInterceptors(FileInterceptor('file'))
  async uploadOne(
    @UploadedFile() file: { buffer: Buffer; mimetype?: string; size?: number },
    @Body('type') type: UploadType = UploadType.cover,
    @Req() req: Request,
  ) {
    const typed = req as Request & { user?: { userId: string } };
    const userId = typed.user?.userId as string;
    if (!file || !file.buffer) throw new BadRequestException('file is required');
    const ct = file.mimetype || 'application/octet-stream';
    const size = Number(file.size || 0);
    // 1) presign
    const presignDto: PresignRequestDto = {
      type,
      contentType: ct,
      size,
    } as PresignRequestDto;
    const pres = await this.uploads.presign(presignDto, userId);
    // 2) direct (using in-memory buffer)
    const direct = await this.uploads.directUpload(pres.token, file.buffer, ct, userId);
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
