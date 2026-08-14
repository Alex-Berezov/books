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
      // `refreshToken` и `accessToken` — проверка того, что совпадение
      // частичное: якорная регулярка их не поймает, а тела реальных ручек
      // входа и обновления сессии несут именно такие имена.
      body: {
        password: 'plaintext',
        refreshToken: 'real-refresh-token',
        accessToken: 'real-access-token',
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

  it('маскирует authorization и cookie в заголовках', () => {
    filter.catch(new Error('boom'), makeHost(makeRequest()));

    const headers = requestContext().headers as Record<string, unknown>;
    expect(headers.authorization).toBe('[Filtered]');
    expect(headers.cookie).toBe('[Filtered]');
    // Несекретные заголовки остаются: событие должно оставаться полезным.
    expect(headers['user-agent']).toBe('jest');
  });

  it('маскирует секреты в query и params', () => {
    filter.catch(new Error('boom'), makeHost(makeRequest()));

    const ctx = requestContext();
    expect((ctx.query as Record<string, unknown>).token).toBe('[Filtered]');
    expect((ctx.query as Record<string, unknown>).page).toBe('1');
    expect((ctx.params as Record<string, unknown>).secret).toBe('[Filtered]');
    expect((ctx.params as Record<string, unknown>).id).toBe('u1');
  });

  it('маскирует тело запроса, как и раньше', () => {
    filter.catch(new Error('boom'), makeHost(makeRequest()));

    const body = requestContext().body as Record<string, unknown>;
    expect(body.password).toBe('[Filtered]');
    expect(body.email).toBe('user@example.com');
  });

  it('ловит имена, где секретное слово лишь часть ключа', () => {
    filter.catch(new Error('boom'), makeHost(makeRequest()));

    const body = requestContext().body as Record<string, unknown>;
    expect(body.refreshToken).toBe('[Filtered]');
    expect(body.accessToken).toBe('[Filtered]');
  });

  it('маскирует заголовки, набранные в верхнем регистре', () => {
    const req = makeRequest({
      headers: { Authorization: 'Bearer real-access-token', Cookie: 'session=x' },
    });
    filter.catch(new Error('boom'), makeHost(req));

    const headers = requestContext().headers as Record<string, unknown>;
    expect(headers.Authorization).toBe('[Filtered]');
    expect(headers.Cookie).toBe('[Filtered]');
  });

  it('маскирует секрет в строке запроса самого адреса', () => {
    filter.catch(new Error('boom'), makeHost(makeRequest()));

    const url = requestContext().url as string;
    expect(url).not.toContain('leaked-query-token');
    // Путь и несекретные параметры остаются: без них событие бесполезно.
    expect(url).toContain('/users/me');
    expect(url).toContain('page=1');
  });

  it('адрес без строки запроса остаётся целым', () => {
    filter.catch(new Error('boom'), makeHost(makeRequest({ originalUrl: '/auth/login' })));

    expect(requestContext().url).toBe('https://api.bibliaris.com/auth/login');
    const messages = scope.addBreadcrumb.mock.calls.map((c) => String(c[0]?.message ?? ''));
    expect(messages.some((m) => m.includes('/auth/login'))).toBe(true);
  });

  it('секретный ключ, записанный процентным кодированием, тоже маскируется', () => {
    // `to%6Ben` — это `token`. Разбор его раскодирует, замена по строке нет.
    filter.catch(
      new Error('boom'),
      makeHost(makeRequest({ originalUrl: '/x?to%6Ben=leaked-encoded-token' })),
    );

    expect(requestContext().url).not.toContain('leaked-encoded-token');
  });

  it('маскирует секрет и в хлебной крошке с адресом', () => {
    filter.catch(new Error('boom'), makeHost(makeRequest()));

    const messages = scope.addBreadcrumb.mock.calls.map((c) => String(c[0]?.message ?? ''));
    expect(messages.join(' ')).not.toContain('leaked-query-token');
    expect(messages.some((m) => m.includes('/users/me'))).toBe(true);
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

  it('4xx в Sentry не уходят', () => {
    filter.catch(new HttpException('nope', HttpStatus.BAD_REQUEST), makeHost(makeRequest()));

    expect(withScopeMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});
