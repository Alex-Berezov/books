import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';
import { PresignRequestDto, UploadType } from './dto/presign.dto';

/**
 * Сторож делегирования (`LEGACY-111`).
 *
 * Права на аудио контроллер больше не считает сам: рукописная копия
 * `checkIsStaff` сведена к `ModeratorRolesService.isModerator`. Мок сервиса
 * решает исход каждого из трёх маршрутов — вернётся копия в контроллер, мок
 * перестанет влиять, и спека покраснеет.
 */

const makeController = (
  isModerator: boolean,
): {
  controller: UploadsController;
  uploads: { presign: jest.Mock; getPublicUrl: jest.Mock; delete: jest.Mock };
  isModeratorMock: jest.Mock;
} => {
  const uploads = {
    presign: jest.fn().mockResolvedValue({ key: 'k', url: 'u', method: 'POST' }),
    getPublicUrl: jest.fn().mockReturnValue('https://cdn.example.com/k'),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const isModeratorMock = jest.fn().mockResolvedValue(isModerator);
  const moderatorRoles = { isModerator: isModeratorMock } as unknown as ModeratorRolesService;

  return {
    controller: new UploadsController(uploads as unknown as UploadsService, moderatorRoles),
    uploads,
    isModeratorMock,
  };
};

const req = (user?: { userId: string; email: string }): Request => ({ user }) as unknown as Request;

const staff = { userId: 'u1', email: 'staff@example.com' };

const dto = (type: UploadType): PresignRequestDto =>
  ({ type, contentType: 'audio/mpeg', size: 1024 }) as PresignRequestDto;

describe('UploadsController', () => {
  describe('presign', () => {
    it('аудио без роли модератора — 403, файл не выдаётся', async () => {
      const { controller, uploads, isModeratorMock } = makeController(false);
      await expect(controller.presign(dto(UploadType.audio), req(staff))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(isModeratorMock).toHaveBeenCalledWith(staff);
      expect(uploads.presign).not.toHaveBeenCalled();
    });

    it('аудио с ролью модератора — подпись выдаётся', async () => {
      const { controller, uploads } = makeController(true);
      await expect(controller.presign(dto(UploadType.audio), req(staff))).resolves.toEqual({
        key: 'k',
        url: 'u',
        method: 'POST',
      });
      expect(uploads.presign).toHaveBeenCalledWith(dto(UploadType.audio), 'u1');
    });

    it('обложку кладёт кто угодно вошедший — роль не спрашивается', async () => {
      const { controller, isModeratorMock } = makeController(false);
      await expect(controller.presign(dto(UploadType.cover), req(staff))).resolves.toBeDefined();
      expect(isModeratorMock).not.toHaveBeenCalled();
    });

    it('без пользователя в запросе — 401', async () => {
      const { controller } = makeController(true);
      await expect(controller.presign(dto(UploadType.cover), req())).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe('confirm', () => {
    it('ключ вне covers/ без роли модератора — 403', async () => {
      const { controller, uploads, isModeratorMock } = makeController(false);
      await expect(controller.confirm('audio/x.mp3', req(staff))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(isModeratorMock).toHaveBeenCalledWith(staff);
      expect(uploads.getPublicUrl).not.toHaveBeenCalled();
    });

    it('ключ вне covers/ с ролью модератора — адрес отдаётся', async () => {
      const { controller } = makeController(true);
      await expect(controller.confirm('audio/x.mp3', req(staff))).resolves.toEqual({
        key: 'audio/x.mp3',
        publicUrl: 'https://cdn.example.com/k',
      });
    });

    it('ключ covers/ роль не спрашивает', async () => {
      const { controller, isModeratorMock } = makeController(false);
      await expect(controller.confirm('covers/x.jpg', req(staff))).resolves.toBeDefined();
      expect(isModeratorMock).not.toHaveBeenCalled();
    });

    it('без пользователя в запросе — 401', async () => {
      const { controller } = makeController(true);
      await expect(controller.confirm('covers/x.jpg', req())).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe('delete', () => {
    it('ключ вне covers/ без роли модератора — 403, объект остаётся', async () => {
      const { controller, uploads, isModeratorMock } = makeController(false);
      await expect(controller.delete('audio/x.mp3', req(staff))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(isModeratorMock).toHaveBeenCalledWith(staff);
      expect(uploads.delete).not.toHaveBeenCalled();
    });

    it('ключ вне covers/ с ролью модератора — объект удаляется', async () => {
      const { controller, uploads } = makeController(true);
      await controller.delete('audio/x.mp3', req(staff));
      expect(uploads.delete).toHaveBeenCalledWith('audio/x.mp3');
    });

    it('ключ covers/ роль не спрашивает', async () => {
      const { controller, uploads, isModeratorMock } = makeController(false);
      await controller.delete('covers/x.jpg', req(staff));
      expect(isModeratorMock).not.toHaveBeenCalled();
      expect(uploads.delete).toHaveBeenCalledWith('covers/x.jpg');
    });

    it('без пользователя в запросе — 401', async () => {
      const { controller } = makeController(true);
      await expect(controller.delete('covers/x.jpg', req())).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });
});
