import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { MediaService } from './media.service';
import { ConfirmMediaDto, MediaListQueryDto } from './dto/create-media.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, Role } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Request } from 'express';

@ApiTags('media')
@Controller()
export class MediaController {
  constructor(private readonly service: MediaService) {}

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
