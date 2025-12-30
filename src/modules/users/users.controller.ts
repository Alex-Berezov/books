import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Req,
  UseGuards,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { IsIn, IsOptional, IsString, IsUrl, MinLength } from 'class-validator';
import { Language as PrismaLanguage, RoleName } from '@prisma/client';
import { Roles, Role } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  IsInt,
  IsOptional as IsOptionalCls,
  IsString as IsStringCls,
  Min,
  Max,
} from 'class-validator';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

interface RequestUser {
  userId: string;
  email: string;
}

class PublicUserDto {
  id!: string;
  email!: string;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  isActive?: boolean;
  avatarUrl?: string | null;
  languagePreference!: string;
  createdAt!: Date;
  lastLogin?: Date | null;
  roles!: ('user' | 'admin' | 'content_manager')[];
}

class ListUsersQueryDto {
  @IsOptionalCls()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptionalCls()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptionalCls()
  @IsStringCls()
  q?: string;

  // 'only' — only staff (admin|content_manager); 'exclude' — exclude staff
  @IsOptionalCls()
  @IsStringCls()
  staff?: 'only' | 'exclude';
}

class PagedUsersDto {
  items!: PublicUserDto[];
  total!: number;
  page!: number;
  limit!: number;
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

  @ApiOperation({ summary: 'List users (admin only)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'q', required: false, type: String, description: 'Search by email or name' })
  @ApiQuery({
    name: 'staff',
    required: false,
    type: String,
    description:
      "Filter staff: 'only' to show only admins/content managers; 'exclude' to hide them",
    enum: ['only', 'exclude'],
  })
  @ApiOkResponse({ type: PagedUsersDto })
  @Roles(Role.Admin)
  @Get()
  list(@Query() query: ListUsersQueryDto) {
    return this.users.list({
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      q: query.q?.trim() || undefined,
      staff: query.staff,
    });
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

  @ApiOperation({ summary: 'Create user (admin only)' })
  @ApiOkResponse({ type: PublicUserDto })
  @Roles(Role.Admin)
  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @ApiOperation({ summary: 'Update user (admin only)' })
  @ApiOkResponse({ type: PublicUserDto })
  @Roles(Role.Admin)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto);
  }
}
