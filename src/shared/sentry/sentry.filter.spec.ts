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

  describe('LEGACY-188: маска секретов идёт вглубь', () => {
    it('маскирует секрет во вложенном объекте', () => {
      const req = makeRequest({ body: { user: { password: 'nested-plaintext' } } });
      filter.catch(new Error('boom'), makeHost(req));

      const body = requestContext().body as { user: Record<string, unknown> };
      expect(body.user.password).toBe('[Filtered]');
    });

    it('маскирует секрет внутри элемента массива', () => {
      const req = makeRequest({
        body: { translations: [{ title: 'ok' }, { accessToken: 'nested-array-token' }] },
      });
      filter.catch(new Error('boom'), makeHost(req));

      const body = requestContext().body as { translations: Record<string, unknown>[] };
      expect(body.translations[0].title).toBe('ok');
      expect(body.translations[1].accessToken).toBe('[Filtered]');
    });

    it('массив длиннее потолка усекается с явной меткой', () => {
      const items = Array.from({ length: 21 }, (_, i) => ({ n: i }));
      filter.catch(new Error('boom'), makeHost(makeRequest({ body: { items } })));

      const body = requestContext().body as { items: unknown[] };
      // Двадцать элементов плюс метка: «их было больше» отличимо от «столько и было».
      expect(body.items).toHaveLength(21);
      expect(body.items[19]).toEqual({ n: 19 });
      expect(body.items[20]).toBe('[Truncated: 1 more]');
    });

    it('контейнер за пределом глубины заменяется меткой, а не разворачивается', () => {
      // Вход — уровень 1, значит объект на пятом уровне уже за пределом.
      const req = makeRequest({
        body: { l2: { l3: { l4: { l5: { password: 'too-deep-plaintext' } } } } },
      });
      filter.catch(new Error('boom'), makeHost(req));

      const body = requestContext().body as { l2: { l3: { l4: Record<string, unknown> } } };
      expect(body.l2.l3.l4.l5).toBe('[MaxDepth]');
      expect(JSON.stringify(requestContext())).not.toContain('too-deep-plaintext');
    });

    it('скаляр за пределом глубины остаётся: имя ключа проверено родителем', () => {
      const req = makeRequest({ body: { l2: { l3: { l4: { l5: 'plain-value' } } } } });
      filter.catch(new Error('boom'), makeHost(req));

      const body = requestContext().body as { l2: { l3: { l4: Record<string, unknown> } } };
      expect(body.l2.l3.l4.l5).toBe('plain-value');
    });

    it('секретный ключ с объектным значением маскируется целиком', () => {
      const req = makeRequest({
        body: { authorization: { scheme: 'Bearer', value: 'real-access-token' } },
      });
      filter.catch(new Error('boom'), makeHost(req));

      const body = requestContext().body as Record<string, unknown>;
      expect(body.authorization).toBe('[Filtered]');
    });

    it('циклическая ссылка не роняет фильтр и не зацикливает обход', () => {
      const cyclic: Record<string, unknown> = { name: 'root' };
      cyclic.self = cyclic;
      filter.catch(new Error('boom'), makeHost(makeRequest({ body: cyclic })));

      const body = requestContext().body as Record<string, unknown>;
      expect(body.name).toBe('root');
      expect(body.self).toBe('[Circular]');
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    });

    it('повторная ссылка на один объект из двух ключей циклом не считается', () => {
      // Множество посещённых держится по текущему пути, а не по всему обходу:
      // глобальное съело бы содержимое второго ключа меткой `[Circular]`.
      const shared = { title: 'shared-node' };
      filter.catch(new Error('boom'), makeHost(makeRequest({ body: { a: shared, b: shared } })));

      const body = requestContext().body as { a: unknown; b: unknown };
      expect(body.a).toEqual({ title: 'shared-node' });
      expect(body.b).toEqual({ title: 'shared-node' });
    });

    it('ключ `__proto__` из тела остаётся собственным и не подменяет прототип', () => {
      // `JSON.parse` заводит `__proto__` обычным собственным ключом, и `Object.keys`
      // его отдаёт. Присваивание в литерал `{}` ушло бы в сеттер `Object.prototype`:
      // ключ пропал бы, а прототипом клона стало бы разобранное тело запроса.
      const body = JSON.parse('{"__proto__":{"leakMe":"raw-value"},"other":"y"}') as Record<
        string,
        unknown
      >;
      filter.catch(new Error('boom'), makeHost(makeRequest({ body })));

      const out = requestContext().body as Record<string, unknown>;
      expect(Object.keys(out)).toEqual(['__proto__', 'other']);
      expect(out.other).toBe('y');
      // Значение не утекло в прототип: наследованного `leakMe` у клона нет.
      expect((out as { leakMe?: unknown }).leakMe).toBeUndefined();
    });

    it('двоичное тело отдаётся размером, а не побайтовым разбором', () => {
      // `POST /uploads/direct` кладёт в `req.body` `Buffer` до 210 МБ. Потолок
      // на 20 элементов сюда не достаёт: `Array.isArray(Buffer)` ложно.
      filter.catch(new Error('boom'), makeHost(makeRequest({ body: Buffer.alloc(4096, 7) })));

      expect(requestContext().body).toBe('[Binary: 4096 bytes]');
    });

    it('двоичное поле внутри тела тоже не разворачивается', () => {
      const body = { note: 'ok', chunk: new Uint8Array(64) };
      filter.catch(new Error('boom'), makeHost(makeRequest({ body })));

      const out = requestContext().body as Record<string, unknown>;
      expect(out.note).toBe('ok');
      expect(out.chunk).toBe('[Binary: 64 bytes]');
    });
  });

  it('4xx в Sentry не уходят', () => {
    filter.catch(new HttpException('nope', HttpStatus.BAD_REQUEST), makeHost(makeRequest()));

    expect(withScopeMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});
