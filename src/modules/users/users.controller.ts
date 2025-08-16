import { Body, Controller, Delete, Get, Param, Patch, Req, UseGuards, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags, ApiParam } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { IsIn, IsOptional, IsString, IsUrl, MinLength } from 'class-validator';
import { Language as PrismaLanguage, RoleName } from '@prisma/client';
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

  @ApiOperation({ summary: 'List user roles (admin only)' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @Roles(Role.Admin)
  @Get(':id/roles')
  listRoles(@Param('id') id: string) {
    return this.users.listRoles(id);
  }

  @ApiOperation({ summary: 'Assign role to user (admin only)' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiParam({ name: 'role', description: 'Role name', enum: ['user', 'admin', 'content_manager'] })
  @Roles(Role.Admin)
  @Post(':id/roles/:role')
  assignRole(@Param('id') id: string, @Param('role') role: RoleName) {
    return this.users.assignRole(id, role);
  }

  @ApiOperation({ summary: 'Revoke role from user (admin only)' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiParam({ name: 'role', description: 'Role name', enum: ['user', 'admin', 'content_manager'] })
  @Roles(Role.Admin)
  @Delete(':id/roles/:role')
  revokeRole(@Param('id') id: string, @Param('role') role: RoleName) {
    return this.users.revokeRole(id, role);
  }
}
