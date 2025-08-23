import {
  Body,
  Controller,
  Delete,
  Headers,
  Post,
  Query,
  Req,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, Role } from '../../common/decorators/roles.decorator';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { PresignRequestDto, PresignResponseDto, DirectUploadResponseDto } from './dto/presign.dto';
import { UploadsService } from './uploads.service';

@ApiTags('Uploads')
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @ApiOperation({ summary: 'Get a presigned direct-upload token and URL' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RateLimitGuard)
  @Roles(Role.Admin, Role.ContentManager)
  @Post('presign')
  async presign(@Body() dto: PresignRequestDto, @Req() req: Request): Promise<PresignResponseDto> {
    const typedReq = req as Request & { user?: { userId: string } };
    const userId = typedReq.user?.userId;
    if (!userId) throw new UnauthorizedException();
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
  @UseGuards(JwtAuthGuard)
  @Roles(Role.Admin, Role.ContentManager)
  @Post('confirm')
  confirm(@Query('key') key: string): DirectUploadResponseDto {
    const url = this.uploads.getPublicUrl(key);
    return { key, publicUrl: url };
  }

  @ApiOperation({ summary: 'Delete uploaded object by key' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Roles(Role.Admin, Role.ContentManager)
  @Delete()
  async delete(@Query('key') key: string): Promise<void> {
    await this.uploads.delete(key);
  }
}
