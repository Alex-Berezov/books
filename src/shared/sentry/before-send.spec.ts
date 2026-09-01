import type { ErrorEvent } from '@sentry/node';

import { MAX_FREE_TEXT_LENGTH } from './redact.util';

import { SENTRY_MAX_VALUE_LENGTH, sentryBeforeSend } from './before-send';

/**
 * Прямые вызовы `beforeSend` (`LEGACY-336`).
 *
 * ⚠️ Через `Sentry.init` эту функцию не проверить: `main.ts` не покрыт ни одним
 * тестом (`bootstrap()` не экспортируется), а обе спеки Sentry подменяют
 * `@sentry/node` целиком через `jest.mock` — колбэк, записанный прямо в `init`,
 * не исполнился бы ни в одной проверке. Отсюда отдельный экспорт и эта спека.
 */
describe('sentryBeforeSend', () => {
  const EMAIL = 'claimant@example.com';
  const HASH = /\[Hashed: [0-9a-f]{12}\]/;

  /**
   * `ErrorEvent` требует `type: undefined` и ещё несколько полей, которых
   * в проверяемых формах нет и быть не должно: спека подаёт ровно те куски
   * события, с которыми функция и работает.
   */
  function asEvent(shape: object): ErrorEvent {
    return shape as unknown as ErrorEvent;
  }

  function eventWith(value: string): ErrorEvent {
    return asEvent({
      exception: { values: [{ type: 'PrismaClientValidationError', value }] },
    });
  }

  describe('🔴 дамп аргументов Prisma не уезжает открытым', () => {
    // Ровно та форма, ради которой запись и заведена: `exception.value` шёл
    // мимо редактора целиком, и в одном событии `body.claimantAddress` был
    // `[Filtered]` белым списком, а тот же адрес в тексте исключения — открыт.
    const PRISMA_MESSAGE = [
      'Invalid `prisma.rightsClaim.create()` invocation in',
      '/app/src/modules/rights-claims/rights-claims.service.ts:88:31',
      '',
      '  data: {',
      '    claimantName: "Иван Петров",',
      `    claimantEmail: "${EMAIL}",`,
      '    claimantAddress: "Москва, Тверская 1",',
      '  }',
    ].join('\n');

    it('имя, адрес и почта заявителя из текста исключения не уезжают', () => {
      const out = sentryBeforeSend(eventWith(PRISMA_MESSAGE));
      const value = out.exception?.values?.[0]?.value ?? '';

      expect(value).not.toContain('Иван Петров');
      expect(value).not.toContain('Тверская');
      expect(value).not.toContain(EMAIL);
    });

    it('имя операции остаётся: без него разбирать отказ нечем', () => {
      const out = sentryBeforeSend(eventWith(PRISMA_MESSAGE));
      const value = out.exception?.values?.[0]?.value ?? '';

      expect(value).toContain('prisma.rightsClaim.create()');
    });

    it('снятый хвост отмечается, а не исчезает молча', () => {
      const out = sentryBeforeSend(eventWith(PRISMA_MESSAGE));
      const value = out.exception?.values?.[0]?.value ?? '';

      expect(value).toMatch(/\[Truncated: \d+ more chars\]$/);
    });
  });

  describe('разбор по значению доезжает и до первой строки', () => {
    it('почта в однострочном сообщении уходит хешем, а не открытой', () => {
      const out = sentryBeforeSend(eventWith(`Failed to notify ${EMAIL}`));

      expect(out.exception?.values?.[0]?.value).toMatch(HASH);
      expect(out.exception?.values?.[0]?.value).not.toContain(EMAIL);
    });

    it('однострочное сообщение метки усечения не получает', () => {
      const out = sentryBeforeSend(eventWith('Connection refused'));

      expect(out.exception?.values?.[0]?.value).toBe('Connection refused');
    });

    it('`event.message` разбирается тем же обращением, что и текст исключения', () => {
      const event = asEvent({ message: `Failed to notify ${EMAIL}` });

      const out = sentryBeforeSend(event);

      expect(out.message).toMatch(HASH);
      expect(out.message).not.toContain(EMAIL);
    });

    it('все элементы `exception.values` обходятся, а не только первый', () => {
      const event = asEvent({
        exception: {
          values: [{ value: `first ${EMAIL}` }, { value: `second ${EMAIL}` }],
        },
      });

      const out = sentryBeforeSend(event);

      expect(out.exception?.values?.[1]?.value).toMatch(HASH);
      expect(JSON.stringify(out)).not.toContain(EMAIL);
    });
  });

  describe('🔴 функция тотальна: бросок отсюда потерял бы событие целиком', () => {
    it('событие без `exception` и без `message` проходит насквозь', () => {
      const event = asEvent({ event_id: 'abc' });

      expect(() => sentryBeforeSend(event)).not.toThrow();
      expect(sentryBeforeSend(event)).toBe(event);
    });

    it('пустой массив `values` обход не роняет', () => {
      const event = asEvent({ exception: { values: [] } });

      expect(() => sentryBeforeSend(event)).not.toThrow();
    });

    it('элемент без `value` и нестроковый `value` обход не роняют', () => {
      const event = asEvent({
        exception: { values: [{ type: 'Error' }, { value: 42 }] },
      });

      expect(() => sentryBeforeSend(event)).not.toThrow();
      expect(event.exception?.values?.[1]?.value).toBe(42);
    });

    it('нестроковый `message` не переписывается', () => {
      const event = asEvent({ message: undefined });

      expect(() => sentryBeforeSend(event)).not.toThrow();
      expect(event.message).toBeUndefined();
    });
  });

  describe('чего `beforeSend` не трогает', () => {
    it('🔴 `stacktrace` остаётся целым: при `integrations: []` у кадров нет `vars`', () => {
      const frames = [{ filename: '/app/src/x.ts', function: 'create', lineno: 12 }];
      const event = asEvent({
        exception: { values: [{ value: 'boom\nи хвост', stacktrace: { frames } }] },
      });

      const out = sentryBeforeSend(event);

      expect(out.exception?.values?.[0]?.stacktrace?.frames).toEqual(frames);
    });

    it('`contexts`, метки и пользователь второй раз не правятся', () => {
      // Они уже прошли редактор в `sentry.filter.ts`; повторный проход
      // упёрся бы в предел глубины на уже отредактированном контексте.
      const event = asEvent({
        message: 'boom',
        contexts: { request: { body: { claimantName: '[Filtered]' } } },
        tags: { route: 'admin/rights/claims' },
        user: { id: '42' },
      });

      const out = sentryBeforeSend(event);

      expect(out.contexts).toEqual({ request: { body: { claimantName: '[Filtered]' } } });
      expect(out.tags).toEqual({ route: 'admin/rights/claims' });
      expect(out.user).toEqual({ id: '42' });
    });
  });
});

describe('sentryBeforeSend: `event.request` (LEGACY-336, решение арбитра 01.09.2026)', () => {
  const EMAIL = 'claimant@example.com';

  function asEvent(shape: object): ErrorEvent {
    return shape as unknown as ErrorEvent;
  }

  describe('🔴 набор интеграций по умолчанию не отключён, и `request` заполняется в обход фильтра', () => {
    function rightsEvent(): ErrorEvent {
      return asEvent({
        request: {
          url: 'https://api.example.com/api/admin/rights/claims?q=Иван&status=OPEN',
          data: {
            claimantName: 'Иван Петров',
            claimantAddress: 'Москва, Тверская 1',
            counterNoticeTextRu: 'проза встречного уведомления',
            status: 'OPEN',
          },
          headers: { authorization: 'Bearer real.jwt.token', 'user-agent': 'curl/8.4.0' },
          cookies: { refreshToken: 'real-refresh-token' },
          query_string: { q: 'Иван', status: 'OPEN' },
        },
      });
    }

    it('сырое тело правовой заявки не уезжает открытым', () => {
      const out = sentryBeforeSend(rightsEvent());
      const dump = JSON.stringify(out);

      expect(dump).not.toContain('Иван Петров');
      expect(dump).not.toContain('Тверская');
      expect(dump).not.toContain('проза встречного уведомления');
    });

    it('перечисленное белым списком остаётся: событие продолжает указывать на запись', () => {
      const out = sentryBeforeSend(rightsEvent());
      const data = out.request?.data as Record<string, unknown>;

      expect(data.status).toBe('OPEN');
    });

    it('🔴 рабочий токен из заголовка не уезжает', () => {
      const out = sentryBeforeSend(rightsEvent());
      const headers = out.request?.headers as Record<string, unknown>;

      expect(headers.authorization).toBe('[Filtered]');
      expect(JSON.stringify(out)).not.toContain('real.jwt.token');
    });

    it('заголовки идут без белого списка: диагностика остаётся', () => {
      // Под белым списком `user-agent` стал бы `[Filtered]` вместе с токеном,
      // и разбирать отказ было бы нечем.
      const out = sentryBeforeSend(rightsEvent());
      const headers = out.request?.headers as Record<string, unknown>;

      expect(headers['user-agent']).toBe('curl/8.4.0');
    });

    it('🔴 сессионная кука не уезжает', () => {
      const out = sentryBeforeSend(rightsEvent());

      expect(JSON.stringify(out)).not.toContain('real-refresh-token');
    });

    it('строка запроса и адрес чистятся тем же списком, что и тело', () => {
      const out = sentryBeforeSend(rightsEvent());
      const qs = out.request?.query_string as Record<string, unknown>;

      expect(qs.status).toBe('OPEN');
      expect(qs.q).toBe('[Filtered]');
      expect(decodeURIComponent(out.request?.url ?? '')).not.toContain('Иван');
    });
  });

  describe('выбор списка по адресу события', () => {
    it('на чужом маршруте белый список не применяется', () => {
      const out = sentryBeforeSend(
        asEvent({
          request: {
            url: 'https://api.example.com/api/books?page=2',
            data: { title: 'Война и мир', page: 2 },
          },
        }),
      );
      const data = out.request?.data as Record<string, unknown>;

      expect(data.title).toBe('Война и мир');
    });

    it('🔴 адреса нет — список применяется: отказ в строгую сторону', () => {
      // Не тот выбор здесь означает не потерю диагностики, а отправку
      // правовой заявки наружу целиком.
      const out = sentryBeforeSend(
        asEvent({ request: { data: { claimedWorkTitle: 'название', status: 'OPEN' } } }),
      );
      const data = out.request?.data as Record<string, unknown>;

      expect(data.claimedWorkTitle).toBe('[Filtered]');
      expect(data.status).toBe('OPEN');
    });
  });

  describe('краевые формы `event.request`', () => {
    it('сырое строковое тело разбирается по значению', () => {
      const out = sentryBeforeSend(
        asEvent({ request: { url: '/api/books', data: `notify ${EMAIL}` } }),
      );

      expect(out.request?.data).toMatch(/\[Hashed: [0-9a-f]{12}\]/);
      expect(out.request?.data).not.toContain(EMAIL);
    });

    it('пустой `request` обход не роняет', () => {
      expect(() => sentryBeforeSend(asEvent({ request: {} }))).not.toThrow();
    });

    it('событие без `request` проходит насквозь', () => {
      const event = asEvent({ message: 'boom' });

      expect(() => sentryBeforeSend(event)).not.toThrow();
      expect(event.request).toBeUndefined();
    });
  });

  describe('чего правка `request` не трогает', () => {
    it('`contexts`, `tags`, `user` и `breadcrumbs` второй раз не правятся', () => {
      const event = asEvent({
        request: { url: '/api/admin/rights/claims', data: { status: 'OPEN' } },
        contexts: { request: { body: { claimantName: '[Filtered]' } } },
        tags: { route: 'admin/rights/claims' },
        user: { id: '42' },
        breadcrumbs: [{ message: 'GET /api/admin/rights/claims' }],
      });

      const out = sentryBeforeSend(event);

      expect(out.contexts).toEqual({ request: { body: { claimantName: '[Filtered]' } } });
      expect(out.tags).toEqual({ route: 'admin/rights/claims' });
      expect(out.user).toEqual({ id: '42' });
      expect(out.breadcrumbs).toEqual([{ message: 'GET /api/admin/rights/claims' }]);
    });
  });
});

describe('SENTRY_MAX_VALUE_LENGTH', () => {
  it('🔴 потолок SDK выше собственного: иначе шов от SDK попадёт в событие', () => {
    // `main.ts` тестом не покрыт, поэтому инвариант держится здесь.
    // Опустись `maxValueLength` до 512 или ниже — SDK резал бы строку раньше
    // нашего разбора, и адрес на границе уезжал бы обрывком.
    expect(SENTRY_MAX_VALUE_LENGTH).toBeGreaterThan(MAX_FREE_TEXT_LENGTH);
  });
});

describe('🔴 настоящая форма сообщения, а не собранная руками', () => {
  function asEvent(shape: object): ErrorEvent {
    return shape as unknown as ErrorEvent;
  }

  it('сообщение с ведущим переводом строки не съедается целиком', () => {
    // `PrismaClientValidationError.message` собирается в рантайме как
    // `['', 'Invalid …', …].join('\n')`, то есть **начинается** с перевода
    // строки. Мутация: убрать отбрасывание ведущих пустых строк — и от текста
    // исключения останется пустая строка при зелёном событии.
    const real = [
      '',
      'Invalid `prisma.rightsClaim.create()` invocation in',
      '  claimantName: "Иван"',
    ].join('\n');

    const out = sentryBeforeSend(
      asEvent({ exception: { values: [{ type: 'PrismaClientValidationError', value: real }] } }),
    );
    const value = out.exception?.values?.[0]?.value ?? '';

    expect(value).not.toBe('');
    expect(value).toContain('prisma.rightsClaim.create()');
    expect(value).not.toContain('Иван');
  });

  it('метка усечения считает содержимое, а не разделители строк', () => {
    const out = sentryBeforeSend(asEvent({ exception: { values: [{ value: 'head\ntail' }] } }));

    expect(out.exception?.values?.[0]?.value).toBe('head[Truncated: 4 more chars]');
  });

  it('однострочное сообщение с адресом у границы 250 знаков доезжает целым и хешируется', () => {
    // Потолок SDK поднят до 8192 (`SENTRY_MAX_VALUE_LENGTH`), поэтому рез
    // на 250 знаках, разрезавший бы адрес пополам, больше не случается:
    // усечение делает наш код после разбора.
    const head = 'x'.repeat(235);
    const out = sentryBeforeSend(
      asEvent({ exception: { values: [{ value: `${head}ceo@example.com tail` }] } }),
    );
    const value = out.exception?.values?.[0]?.value ?? '';

    expect(value).not.toContain('ceo@');
    expect(value).toMatch(/\[Hashed: [0-9a-f]{12}\]/);
    expect(value).toContain('tail');
  });
});
