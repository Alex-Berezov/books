import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Observable } from 'rxjs';

/**
 * Гвард для маршрутов, открытых анониму, но отдающих персональную часть
 * владельцу токена (`LEGACY-088`).
 *
 * Заголовка нет — запрос идёт дальше без `req.user`. Заголовок есть — токен
 * проверяется строго, и невалидный даёт 401.
 *
 * ⚠️ Молчаливая деградация «плохой токен = аноним» здесь была бы хуже отказа:
 * протухший токен тогда не чинится рефрешем, а тихо возвращает ответ без
 * персональной части — читатель открывает книгу с начала и не понимает,
 * почему. 401 фронт умеет обработать, пустой ответ — нет.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    const request = context.switchToHttp().getRequest<{ headers?: Record<string, unknown> }>();
    const header = request.headers?.authorization;

    if (typeof header !== 'string' || header.trim() === '') {
      return true;
    }

    return super.canActivate(context);
  }
}
