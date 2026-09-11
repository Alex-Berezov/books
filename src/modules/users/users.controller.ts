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
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiParam,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RoleName } from '@prisma/client';
import { Roles, Role } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { PublicUserDto, PublicUserWithRolesDto } from './dto/public-user.dto';
import { UserRoleDto } from './dto/user-role.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { PagedUsersDto } from './dto/paged-users.dto';
import { UpdateMeDto } from './dto/update-me.dto';
import { PagedUserActivitiesDto } from './dto/paged-user-activities.dto';
import { PaginationDto } from '../../shared/dto/pagination.dto';

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
  @Get('me')
  @ApiOkResponse({ type: PublicUserWithRolesDto })
  me(@Req() req: { user: RequestUser }) {
    return this.users.me(req.user.userId);
  }

  @ApiOperation({ summary: 'Get current user activities (comments & replies)' })
  @Get('me/activities')
  @ApiOkResponse({ type: PagedUserActivitiesDto })
  meActivities(@Req() req: { user: RequestUser }, @Query() query: PaginationDto) {
    return this.users.getActivities(req.user.userId, query.page, query.limit);
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
  @Patch('profile')
  @ApiOkResponse({ type: PublicUserDto })
  updateProfile(@Req() req: { user: RequestUser }, @Body() dto: UpdateMeDto) {
    return this.users.updateMe(req.user.userId, dto);
  }

  @ApiOperation({ summary: 'Update current user profile' })
  @Patch('me')
  @ApiOkResponse({ type: PublicUserDto })
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
  @ApiOkResponse({ type: PublicUserDto })
  deleteById(@Param('id') id: string) {
    return this.users.deleteById(id);
  }

  @ApiOperation({ summary: 'List user roles (admin only)' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @Roles(Role.Admin)
  @Get(':id/roles')
  @ApiOkResponse({
    description: 'Role names assigned to the user',
    schema: { type: 'array', items: { type: 'string', enum: Object.values(RoleName) } },
  })
  listRoles(@Param('id') id: string) {
    return this.users.listRoles(id);
  }

  @ApiOperation({ summary: 'Assign role to user (admin only)' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiParam({ name: 'role', description: 'Role name', enum: ['user', 'admin', 'content_manager'] })
  @Roles(Role.Admin)
  @Post(':id/roles/:role')
  @ApiCreatedResponse({ type: UserRoleDto })
  assignRole(
    @Param('id') id: string,
    @Param('role') role: RoleName,
    @Req() req: { user: RequestUser },
  ) {
    // Актёр берётся из запроса, а не из тела: журнал прав должен отвечать «кто»,
    // а не «кто представился» (`LEGACY-015`).
    return this.users.assignRole(id, role, req.user.userId);
  }

  @ApiOperation({ summary: 'Revoke role from user (admin only)' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiParam({ name: 'role', description: 'Role name', enum: ['user', 'admin', 'content_manager'] })
  @Roles(Role.Admin)
  @Delete(':id/roles/:role')
  @ApiOkResponse({ type: UserRoleDto })
  revokeRole(
    @Param('id') id: string,
    @Param('role') role: RoleName,
    @Req() req: { user: RequestUser },
  ) {
    return this.users.revokeRole(id, role, req.user.userId);
  }

  @ApiOperation({ summary: 'Create user (admin only)' })
  @ApiOkResponse({ type: PublicUserWithRolesDto })
  @Roles(Role.Admin)
  @Post()
  create(@Body() dto: CreateUserDto, @Req() req: { user: RequestUser }) {
    // Актёр берётся из запроса, а не из тела: журнал прав должен отвечать «кто»,
    // а не «кто представился» (`LEGACY-015`).
    return this.users.create(dto, req.user.userId);
  }

  @ApiOperation({ summary: 'Update user (admin only)' })
  @ApiOkResponse({ type: PublicUserWithRolesDto })
  @Roles(Role.Admin)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto, @Req() req: { user: RequestUser }) {
    return this.users.update(id, dto, req.user.userId);
  }
}
