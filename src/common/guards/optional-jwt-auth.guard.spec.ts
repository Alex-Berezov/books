import { ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';

const contextWith = (headers: Record<string, unknown>): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  }) as unknown as ExecutionContext;

/**
 * Граница «аноним / владелец токена» для маршрутов, открытых обоим
 * (`LEGACY-088`). Ошибка в любую сторону дорогая: пропустить негодный токен —
 * молча потерять персональную часть, потребовать токен — закрыть читалку и
 * отзывы для незалогиненных.
 */
describe('OptionalJwtAuthGuard', () => {
  let superCanActivate: jest.SpyInstance;

  beforeEach(() => {
    superCanActivate = jest
      .spyOn(AuthGuard('jwt').prototype as { canActivate: () => boolean }, 'canActivate')
      .mockReturnValue(true);
  });

  afterEach(() => {
    superCanActivate.mockRestore();
  });

  it('пропускает запрос без заголовка, не трогая passport', () => {
    const guard = new OptionalJwtAuthGuard();

    expect(guard.canActivate(contextWith({}))).toBe(true);
    expect(superCanActivate).not.toHaveBeenCalled();
  });

  // Пустая строка — это «токена нет», а не «токен плохой»: некоторые клиенты
  // шлют пустой заголовок вместо того, чтобы опустить его.
  it('считает пустой заголовок отсутствующим', () => {
    const guard = new OptionalJwtAuthGuard();

    expect(guard.canActivate(contextWith({ authorization: '   ' }))).toBe(true);
    expect(superCanActivate).not.toHaveBeenCalled();
  });

  // 🔴 Присланный токен обязан пройти обычную строгую проверку: молчаливая
  // деградация до анонима вернула бы 200 без персональной части, и протухшая
  // сессия выглядела бы как потеря места в книге вместо повода обновить токен.
  it('проверяет присланный токен обычным путём', () => {
    const guard = new OptionalJwtAuthGuard();

    expect(guard.canActivate(contextWith({ authorization: 'Bearer token' }))).toBe(true);
    expect(superCanActivate).toHaveBeenCalledTimes(1);
  });
});
