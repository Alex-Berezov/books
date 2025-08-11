import { Body, Controller, Delete, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { IsIn, IsOptional, IsString, IsUrl, MinLength } from 'class-validator';
import { Language as PrismaLanguage } from '@prisma/client';
import { Roles, Role } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

interface RequestUser {
  userId: string;
  email: string;
}

class PublicUserDto {
  id!: string;
  email!: string;
  name?: string | null;
  avatarUrl?: string | null;
  languagePreference!: string;
  createdAt!: Date;
  lastLogin?: Date | null;
}

class UpdateMeDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsUrl()
  avatarUrl?: string;

  @IsOptional()
  @IsIn(Object.values(PrismaLanguage))
  languagePreference?: PrismaLanguage;
}

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @ApiOperation({ summary: 'Get current user profile' })
  @ApiOkResponse({ type: PublicUserDto })
  @Get('me')
  me(@Req() req: { user: RequestUser }) {
    return this.users.me(req.user.userId);
  }

  @ApiOperation({ summary: 'Update current user profile' })
  @ApiOkResponse({ type: PublicUserDto })
  @Patch('me')
  updateMe(@Req() req: { user: RequestUser }, @Body() dto: UpdateMeDto) {
    return this.users.updateMe(req.user.userId, dto);
  }

  @ApiOperation({ summary: 'Get user by id (admin only)' })
  @ApiOkResponse({ type: PublicUserDto })
  @Roles(Role.Admin)
  @Get(':id')
  getById(@Param('id') id: string) {
    return this.users.getById(id);
  }

  @ApiOperation({ summary: 'Delete user by id (admin only)' })
  @Roles(Role.Admin)
  @Delete(':id')
  deleteById(@Param('id') id: string) {
    return this.users.deleteById(id);
  }
}
