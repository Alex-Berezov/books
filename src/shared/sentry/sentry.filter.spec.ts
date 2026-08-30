import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';

// Мок ставится до импорта фильтра: тот берёт `Sentry.withScope` при вызове,
// но модуль-оригинал тянет за собой инициализацию клиента.
jest.mock('@sentry/node', () => ({
  __esModule: true,
  captureException: jest.fn(),
  withScope: jest.fn(),
  init: jest.fn(),
}));

import * as Sentry from '@sentry/node';
import { SentryExceptionFilter } from './sentry.filter';

type Scope = {
  setTag: jest.Mock;
  setContext: jest.Mock;
  setUser: jest.Mock;
  addBreadcrumb: jest.Mock;
};

const withScopeMock = Sentry.withScope as unknown as jest.Mock;
const captureExceptionMock = Sentry.captureException as unknown as jest.Mock;

/**
 * Здесь проверяется только работа самого фильтра: что уходит в контекст события,
 * чем событие атрибутируется и какие статусы вообще доезжают до Sentry.
 *
 * ⚠️ Поведение редактора (глубина, циклы, усечение, двоичное тело, разбор адреса)
 * живёт в `redact.util.spec.ts` и проверяется прямыми вызовами (`LEGACY-331`).
 * Здесь остаётся ровно одна его сторона — что каждое поле контекста через
 * редактор действительно проходит.
 */
describe('SentryExceptionFilter (unit)', () => {
  let scope: Scope;
  let filter: SentryExceptionFilter;

  /** Запрос с секретами во всех четырёх местах контекста события. */
  function makeRequest(overrides: Record<string, unknown> = {}) {
    return {
      method: 'POST',
      path: '/users/me',
      originalUrl: '/users/me?page=1&token=leaked-query-token',
      protocol: 'https',
      ip: '203.0.113.10',
      get: (name: string) => (name === 'host' ? 'api.bibliaris.com' : undefined),
      // Express отдаёт имена заголовков в нижнем регистре.
      headers: {
        authorization: 'Bearer real-access-token',
        cookie: 'session=real-session-value',
        'user-agent': 'jest',
      },
      query: { token: 'leaked-query-token', page: '1' },
      params: { secret: 'leaked-param-secret', id: 'u1' },
      body: {
        password: 'plaintext',
        refreshToken: 'real-refresh-token',
        email: 'user@example.com',
      },
      ...overrides,
    };
  }

  function makeHost(req: unknown): ArgumentsHost {
    return {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ArgumentsHost;
  }

  /** Объект, отданный в `scope.setContext('request', ...)`. */
  function requestContext(): Record<string, unknown> {
    const call = scope.setContext.mock.calls.find((c) => c[0] === 'request');
    expect(call).toBeDefined();
    return call![1] as Record<string, unknown>;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    // Стандартный хвост фильтра уходит в BaseExceptionFilter и требует живой
    // http-адаптер; в юните он не проверяется.
    jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);

    scope = {
      setTag: jest.fn(),
      setContext: jest.fn(),
      setUser: jest.fn(),
      addBreadcrumb: jest.fn(),
    };
    withScopeMock.mockImplementation((cb: (s: Scope) => void) => cb(scope));

    const adapterHost = { httpAdapter: {} } as unknown as HttpAdapterHost;
    filter = new SentryExceptionFilter(adapterHost, true);
  });

  describe('LEGACY-115: каждое поле контекста проходит через редактор', () => {
    it('заголовки', () => {
      filter.catch(new Error('boom'), makeHost(makeRequest()));

      const headers = requestContext().headers as Record<string, unknown>;
      expect(headers.authorization).toBe('[Filtered]');
      expect(headers.cookie).toBe('[Filtered]');
      // Несекретные заголовки остаются: событие должно оставаться полезным.
      expect(headers['user-agent']).toBe('jest');
    });

    it('query и params', () => {
      filter.catch(new Error('boom'), makeHost(makeRequest()));

      const ctx = requestContext();
      expect((ctx.query as Record<string, unknown>).token).toBe('[Filtered]');
      expect((ctx.query as Record<string, unknown>).page).toBe('1');
      expect((ctx.params as Record<string, unknown>).secret).toBe('[Filtered]');
      expect((ctx.params as Record<string, unknown>).id).toBe('u1');
    });

    it('тело запроса', () => {
      filter.catch(new Error('boom'), makeHost(makeRequest()));

      const body = requestContext().body as Record<string, unknown>;
      expect(body.password).toBe('[Filtered]');
      expect(body.refreshToken).toBe('[Filtered]');
      // `LEGACY-332`: до 30.08.2026 здесь стояло `toBe('user@example.com')` —
      // спека фиксировала утечку почты как ожидаемое поведение.
      expect(body.email).toMatch(/^\[Hashed: [0-9a-f]{12}\]$/);
    });

    it('адрес события', () => {
      filter.catch(new Error('boom'), makeHost(makeRequest()));

      const url = requestContext().url as string;
      expect(url).not.toContain('leaked-query-token');
      // Путь и несекретные параметры остаются: без них событие бесполезно.
      expect(url).toContain('/users/me');
      expect(url).toContain('page=1');
    });

    it('ни одно значение контекста не содержит рабочий токен', () => {
      filter.catch(new Error('boom'), makeHost(makeRequest()));

      const serialized = JSON.stringify(requestContext());
      expect(serialized).not.toContain('real-access-token');
      expect(serialized).not.toContain('real-session-value');
      expect(serialized).not.toContain('leaked-param-secret');
      expect(serialized).not.toContain('leaked-query-token');
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * ⚠️ Блок стоит отдельно от проверок редактора намеренно: обе эти вещи
   * решением арбитра от 30.08.2026 обращаются НЕ так, как ключи тела, — `ip`
   * через редактор не идёт вовсе, а полнота снятия почты проверяется по всему
   * событию, включая метки и хлебные крошки, куда редактор не смотрит. Уедут
   * они вместе с блоком про редактор — проверить их в `redact.util.spec.ts`
   * будет нечем.
   */
  describe('LEGACY-332: решение арбитра о персональных данных события', () => {
    it('почта не встречается ни в одном поле события открытым текстом', () => {
      // Почта уезжала вторым каналом — телом контекста, рядом с маршрутом и `ip`.
      const req = makeRequest({ originalUrl: '/auth/login?email=user@example.com' });
      filter.catch(new Error('boom'), makeHost(req));

      const everything = JSON.stringify([
        requestContext(),
        scope.setTag.mock.calls,
        scope.addBreadcrumb.mock.calls,
      ]);
      expect(everything).not.toContain('user@example.com');
      expect(everything).not.toContain('user%40example.com');
    });

    it('`ip` остаётся в контексте: за Cloudflare это узел, а не человек', () => {
      // Маска на нём почти ничего не прячет, а атрибуцию инцидента снимает.
      filter.catch(new Error('boom'), makeHost(makeRequest()));

      expect(requestContext().ip).toBe('203.0.113.10');
    });
  });

  describe('хлебные крошки', () => {
    it('адрес крошки чистится тем же разбором, что и адрес события', () => {
      filter.catch(new Error('boom'), makeHost(makeRequest()));

      const messages = scope.addBreadcrumb.mock.calls.map((c) => String(c[0]?.message ?? ''));
      expect(messages.join(' ')).not.toContain('leaked-query-token');
      expect(messages.some((m) => m.includes('/users/me'))).toBe(true);
    });

    it('адрес без строки запроса доезжает целым', () => {
      filter.catch(new Error('boom'), makeHost(makeRequest({ originalUrl: '/auth/login' })));

      expect(requestContext().url).toBe('https://api.bibliaris.com/auth/login');
      const messages = scope.addBreadcrumb.mock.calls.map((c) => String(c[0]?.message ?? ''));
      expect(messages.some((m) => m.includes('/auth/login'))).toBe(true);
    });
  });

  describe('LEGACY-187: атрибуция события идентификатором, но не почтой', () => {
    it('идентификатор пользователя уходит в событие из `userId`', () => {
      // Стратегия кладёт в запрос именно `userId` (auth/strategies/jwt.strategy.ts).
      // До правки фильтр читал `id`, ветка не срабатывала ни разу, и события
      // уходили без атрибуции вовсе — эта проверка стережёт саму её живость.
      const req = makeRequest({ user: { userId: 'u-42', email: 'user@example.com' } });
      filter.catch(new Error('boom'), makeHost(req));

      expect(scope.setUser).toHaveBeenCalledTimes(1);
      expect(scope.setUser.mock.calls[0][0]).toEqual({ id: 'u-42' });
    });

    it('почты в объекте пользователя нет', () => {
      const req = makeRequest({ user: { userId: 'u-42', email: 'user@example.com' } });
      filter.catch(new Error('boom'), makeHost(req));

      const passed = scope.setUser.mock.calls[0][0] as Record<string, unknown>;
      expect(Object.keys(passed)).toEqual(['id']);
      expect(JSON.stringify(passed)).not.toContain('user@example.com');
    });

    it('без пользователя в запросе `setUser` не зовётся', () => {
      filter.catch(new Error('boom'), makeHost(makeRequest()));

      expect(scope.setUser).not.toHaveBeenCalled();
    });
  });

  describe('разбор статусов', () => {
    it('метки события несут метод, маршрут и статус', () => {
      filter.catch(new Error('boom'), makeHost(makeRequest()));

      const tags = Object.fromEntries(scope.setTag.mock.calls as [string, string][]);
      expect(tags.method).toBe('POST');
      expect(tags.route).toBe('/users/me');
      expect(tags.status_code).toBe('500');
    });

    it('4xx в Sentry не уходят', () => {
      filter.catch(new HttpException('nope', HttpStatus.BAD_REQUEST), makeHost(makeRequest()));

      expect(withScopeMock).not.toHaveBeenCalled();
      expect(captureExceptionMock).not.toHaveBeenCalled();
    });

    it('5xx, объявленный исключением, уходит со своим статусом', () => {
      filter.catch(new HttpException('gateway', HttpStatus.BAD_GATEWAY), makeHost(makeRequest()));

      const tags = Object.fromEntries(scope.setTag.mock.calls as [string, string][]);
      expect(tags.status_code).toBe('502');
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    });
  });
});
