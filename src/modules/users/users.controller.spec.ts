import { Test, TestingModule } from '@nestjs/testing';
import { RoleName } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

/**
 * 🔴 LEGACY-015. Журнал административных действий отвечает на вопрос «кто», и единственное
 * место, где в этот ответ подставляется актёр, — проводка аргументов в контроллере.
 *
 * ⚠️ Посадка нужна именно здесь, а не в сервисе: сервис получает `actorUserId` готовым
 * и подмены не увидит. А подмена дешёвая и правдоподобная — `req.user.userId` на `id`
 * из адреса: код собирается, все сервисные тесты остаются зелёными, а каждое событие
 * в журнале оказывается приписано **жертве** действия вместо исполнителя.
 *
 * ⚠️ Поэтому id актёра и id цели в фикстурах обязаны различаться (L-004). Совпади они —
 * подмена перестала бы ронять эти тесты, и посадка превратилась бы в украшение.
 */
describe('UsersController (роли и актёр журнала)', () => {
  const ACTOR_ID = 'admin-actor-1';
  const TARGET_ID = 'target-user-2';

  let controller: UsersController;
  let service: Record<string, jest.Mock>;

  const req = { user: { userId: ACTOR_ID, email: 'admin@example.com' } };

  beforeEach(async () => {
    service = {
      assignRole: jest.fn().mockResolvedValue({ userId: TARGET_ID, role: 'admin' }),
      revokeRole: jest.fn().mockResolvedValue({ userId: TARGET_ID, role: 'admin' }),
      create: jest.fn().mockResolvedValue({ id: 'new-user', roles: [] }),
      update: jest.fn().mockResolvedValue({ id: TARGET_ID, roles: [] }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<UsersController>(UsersController);
  });

  it('assignRole: актёр берётся из токена, цель — из адреса', async () => {
    await controller.assignRole(TARGET_ID, 'admin' as RoleName, req);

    expect(service.assignRole).toHaveBeenCalledTimes(1);
    expect(service.assignRole).toHaveBeenCalledWith(TARGET_ID, 'admin', ACTOR_ID);
  });

  it('revokeRole: актёр берётся из токена, цель — из адреса', async () => {
    await controller.revokeRole(TARGET_ID, 'admin' as RoleName, req);

    expect(service.revokeRole).toHaveBeenCalledTimes(1);
    expect(service.revokeRole).toHaveBeenCalledWith(TARGET_ID, 'admin', ACTOR_ID);
  });

  it('update: актёр берётся из токена, цель — из адреса', async () => {
    const dto = { roles: ['content_manager'] } as unknown as UpdateUserDto;

    await controller.update(TARGET_ID, dto, req);

    expect(service.update).toHaveBeenCalledTimes(1);
    expect(service.update).toHaveBeenCalledWith(TARGET_ID, dto, ACTOR_ID);
  });

  it('create: актёр берётся из токена, а не из тела запроса', async () => {
    const dto = {
      email: 'new@example.com',
      password: 'secret-password',
      roles: [RoleName.admin],
    } as unknown as CreateUserDto;

    await controller.create(dto, req);

    expect(service.create).toHaveBeenCalledTimes(1);
    expect(service.create).toHaveBeenCalledWith(dto, ACTOR_ID);
  });
});
