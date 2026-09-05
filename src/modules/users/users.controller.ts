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
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags, ApiParam } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RoleName } from '@prisma/client';
import { Roles, Role } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { PublicUserDto, PublicUserWithRolesDto } from './dto/public-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { PagedUsersDto } from './dto/paged-users.dto';
import { UpdateMeDto } from './dto/update-me.dto';
import { UserActivityDto } from './dto/user-activity.dto';

interface RequestUser {
  userId: string;
  email: string;
}

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @ApiOperation({ summary: 'Get current user profile' })
  @ApiOkResponse({ type: PublicUserWithRolesDto })
  @Get('me')
  me(@Req() req: { user: RequestUser }) {
    return this.users.me(req.user.userId);
  }

  @ApiOperation({ summary: 'Get current user activities (comments & replies)' })
  @ApiOkResponse({ type: UserActivityDto, isArray: true })
  @Get('me/activities')
  meActivities(@Req() req: { user: RequestUser }): Promise<UserActivityDto[]> {
    return this.users.getActivities(req.user.userId);
  }

  // Параметры описаны в `ListUsersQueryDto`: явного блока `@ApiQuery` здесь нет
  // намеренно. Nest собирает параметры и из декораторов, и из типа `@Query()`,
  // и два описания одного параметра — это два источника формы, из кода
  // неразличимые (`LEGACY-133`; найдено ревью в этом заходе).
  @ApiOperation({ summary: 'List users (admin only)' })
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

  @ApiOperation({ summary: 'Update current user profile (alternative profile path)' })
  @ApiOkResponse({ type: PublicUserDto })
  @Patch('profile')
  updateProfile(@Req() req: { user: RequestUser }, @Body() dto: UpdateMeDto) {
    return this.users.updateMe(req.user.userId, dto);
  }

  @ApiOperation({ summary: 'Update current user profile' })
  @ApiOkResponse({ type: PublicUserDto })
  @Patch('me')
  updateMe(@Req() req: { user: RequestUser }, @Body() dto: UpdateMeDto) {
    return this.users.updateMe(req.user.userId, dto);
  }

  // ⚠️ С ролями: `UsersService.getById` объявлен `Promise<PublicUser>`, но телом
  // делегирует в `me()` (`users.service.ts:72-74`), а тот роли кладёт. Объявленный
  // тип их только прячет от компилятора — из ответа они не исчезают
  // (найдено ревью в этом заходе).
  @ApiOperation({ summary: 'Get user by id (admin only)' })
  @ApiOkResponse({ type: PublicUserWithRolesDto })
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
  @ApiOkResponse({ type: PublicUserWithRolesDto })
  @Roles(Role.Admin)
  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @ApiOperation({ summary: 'Update user (admin only)' })
  @ApiOkResponse({ type: PublicUserWithRolesDto })
  @Roles(Role.Admin)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(id, dto);
  }
}
