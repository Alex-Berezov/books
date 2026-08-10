import { ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';

/**
 * Два независимых способа получить реестр метрик — скрейпер и человек.
 *
 * 🔴 `LEGACY-072` закрыл `/api/metrics` гвардом `admin`, и это было правильно:
 * анонимно маршрут отдавал состав маршрутов, объёмы трафика и коды ответов.
 * Побочный итог — job `books-app` в Prometheus пришлось отключить, и метрик у
 * приложения не стало вовсе. В комментариях тогда осталось «скрейпер предъявить
 * токен не умеет» — это **неверно**: Prometheus поддерживает статический bearer
 * (`authorization.credentials`). Не годился именно **JWT**: он живёт 12 часов.
 *
 * Поэтому здесь два пути:
 *
 * 1. `METRICS_TOKEN` — долгоживущий секрет, дающий доступ **только** к этому
 *    маршруту. Ничего, кроме чтения метрик, им сделать нельзя;
 * 2. обычный админский JWT — чтобы человек мог открыть метрики руками.
 *
 * ⚠️ Пустой или незаданный `METRICS_TOKEN` не открывает маршрут: сравнение идёт
 * только когда секрет непустой. Иначе отсутствие переменной в окружении молча
 * превращало бы метрики в публичные — то есть возвращало бы ровно ту дыру,
 * ради закрытия которой всё это делалось.
 */
@Injectable()
export class MetricsAccessGuard extends AuthGuard('jwt') {
  constructor(
    private readonly config: ConfigService,
    private readonly roles: ModeratorRolesService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers?: Record<string, unknown>;
      user?: { userId: string; email: string };
    }>();

    const header = request.headers?.authorization;
    const bearer =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    const metricsToken = (this.config.get<string>('METRICS_TOKEN') || '').trim();
    if (metricsToken && bearer && bearer === metricsToken) {
      return true;
    }

    const authenticated = (await super.canActivate(context)) as boolean;
    if (!authenticated) return false;

    return this.roles.isAdmin(request.user);
  }
}
