import { redactKeys, redactUrl } from './redact.util';

/**
 * Прямые вызовы редактора (`LEGACY-331`). До 30.08.2026 эти же проверки гоняли
 * чистую логику через `filter.catch` с моками `ArgumentsHost`, `Sentry.withScope`
 * и области событий: чтобы проверить усечение массива на 21 элементе, спека
 * собирала HTTP-запрос с заголовками, `query`, `params` и адресом.
 */
describe('redactKeys', () => {
  function asObject(value: unknown): Record<string, unknown> {
    return value as Record<string, unknown>;
  }

  describe('маска по имени ключа', () => {
    it('маскирует значения секретных ключей верхнего уровня', () => {
      const out = asObject(redactKeys({ password: 'plaintext', secret: 'leaked', page: '1' }));

      expect(out.password).toBe('[Filtered]');
      expect(out.secret).toBe('[Filtered]');
      // Несекретные значения остаются: событие должно оставаться полезным.
      expect(out.page).toBe('1');
    });

    it('ловит имена, где секретное слово лишь часть ключа', () => {
      // Тела реальных ручек входа и обновления сессии несут именно такие имена.
      const out = asObject(
        redactKeys({ refreshToken: 'real-refresh-token', accessToken: 'real-access-token' }),
      );

      expect(out.refreshToken).toBe('[Filtered]');
      expect(out.accessToken).toBe('[Filtered]');
    });

    it('регистр имени не важен', () => {
      // Express отдаёт заголовки в нижнем регистре, тело приходит в чужом.
      const out = asObject(redactKeys({ Authorization: 'Bearer x', Cookie: 'session=y' }));

      expect(out.Authorization).toBe('[Filtered]');
      expect(out.Cookie).toBe('[Filtered]');
    });

    it('секретный ключ с объектным значением маскируется целиком', () => {
      const out = asObject(
        redactKeys({ authorization: { scheme: 'Bearer', value: 'real-access-token' } }),
      );

      expect(out.authorization).toBe('[Filtered]');
    });

    it('скаляр и `null` проходят насквозь', () => {
      expect(redactKeys('plain')).toBe('plain');
      expect(redactKeys(42)).toBe(42);
      expect(redactKeys(null)).toBeNull();
      expect(redactKeys(undefined)).toBeUndefined();
    });
  });

  describe('рекурсивный проход', () => {
    it('маскирует секрет во вложенном объекте', () => {
      const out = asObject(redactKeys({ user: { password: 'nested-plaintext' } }));

      expect(asObject(out.user).password).toBe('[Filtered]');
    });

    it('маскирует секрет внутри элемента массива', () => {
      const out = asObject(
        redactKeys({ translations: [{ title: 'ok' }, { accessToken: 'nested-array-token' }] }),
      );

      const translations = out.translations as Record<string, unknown>[];
      expect(translations[0].title).toBe('ok');
      expect(translations[1].accessToken).toBe('[Filtered]');
    });

    it('контейнер за пределом глубины заменяется меткой, а не разворачивается', () => {
      // Вход — уровень 1, значит объект на пятом уровне уже за пределом.
      const out = redactKeys({ l2: { l3: { l4: { l5: { password: 'too-deep-plaintext' } } } } });

      const l4 = asObject(asObject(asObject(asObject(out).l2).l3).l4);
      expect(l4.l5).toBe('[MaxDepth]');
      expect(JSON.stringify(out)).not.toContain('too-deep-plaintext');
    });

    it('скаляр за пределом глубины остаётся: имя ключа проверено родителем', () => {
      const out = redactKeys({ l2: { l3: { l4: { l5: 'plain-value' } } } });

      const l4 = asObject(asObject(asObject(asObject(out).l2).l3).l4);
      expect(l4.l5).toBe('plain-value');
    });
  });

  describe('пределы обхода', () => {
    it('массив длиннее потолка усекается с явной меткой', () => {
      const items = Array.from({ length: 21 }, (_, i) => ({ n: i }));

      const out = redactKeys(items) as unknown[];

      // Двадцать элементов плюс метка: «их было больше» отличимо от «столько и было».
      expect(out).toHaveLength(21);
      expect(out[19]).toEqual({ n: 19 });
      expect(out[20]).toBe('[Truncated: 1 more]');
    });

    it('массив ровно по потолку метки не получает', () => {
      const items = Array.from({ length: 20 }, (_, i) => ({ n: i }));

      const out = redactKeys(items) as unknown[];

      expect(out).toHaveLength(20);
      expect(out[19]).toEqual({ n: 19 });
    });

    it('циклическая ссылка не роняет обход', () => {
      const cyclic: Record<string, unknown> = { name: 'root' };
      cyclic.self = cyclic;

      const out = asObject(redactKeys(cyclic));

      expect(out.name).toBe('root');
      expect(out.self).toBe('[Circular]');
    });

    it('повторная ссылка на один объект из двух ключей циклом не считается', () => {
      // Множество посещённых держится по текущему пути, а не по всему обходу:
      // глобальное съело бы содержимое второго ключа меткой `[Circular]`.
      const shared = { title: 'shared-node' };

      const out = asObject(redactKeys({ a: shared, b: shared }));

      expect(out.a).toEqual({ title: 'shared-node' });
      expect(out.b).toEqual({ title: 'shared-node' });
    });
  });

  describe('двоичное значение', () => {
    it('двоичное значение целиком отдаётся размером, а не побайтовым разбором', () => {
      // `POST /uploads/direct` кладёт в `req.body` `Buffer` до 210 МБ. Потолок
      // на 20 элементов сюда не достаёт: `Array.isArray(Buffer)` ложно.
      expect(redactKeys(Buffer.alloc(4096, 7))).toBe('[Binary: 4096 bytes]');
    });

    it('двоичное поле внутри объекта тоже не разворачивается', () => {
      const out = asObject(redactKeys({ note: 'ok', chunk: new Uint8Array(64) }));

      expect(out.note).toBe('ok');
      expect(out.chunk).toBe('[Binary: 64 bytes]');
    });

    it('сырой `ArrayBuffer` отдаётся размером', () => {
      expect(redactKeys(new ArrayBuffer(128))).toBe('[Binary: 128 bytes]');
    });
  });

  describe('LEGACY-332: почта уходит хешем, а не открытым текстом', () => {
    it('почта в теле не уезжает открытой', () => {
      // Тело `POST /auth/login`, упавшего в 500, — тот самый второй канал.
      const out = asObject(redactKeys({ email: 'user@example.com', password: 'x' }));

      expect(out.email).not.toBe('user@example.com');
      expect(String(out.email)).toMatch(/^\[Hashed: [0-9a-f]{12}\]$/);
      expect(JSON.stringify(out)).not.toContain('user@example.com');
    });

    it('одинаковая почта даёт одинаковый хеш', () => {
      // Ради этого выбран хеш, а не маска: «упало у одного двести раз»
      // должно отличаться от «упало у двухсот по разу».
      const first = asObject(redactKeys({ email: 'user@example.com' })).email;
      const second = asObject(redactKeys({ email: 'user@example.com' })).email;

      expect(first).toBe(second);
    });

    it('разные почты дают разные хеши', () => {
      const first = asObject(redactKeys({ email: 'one@example.com' })).email;
      const second = asObject(redactKeys({ email: 'two@example.com' })).email;

      expect(first).not.toBe(second);
    });

    it('регистр и пробелы по краям на хеш не влияют', () => {
      // Без нормализации один человек считался бы за двоих — ровно та ошибка
      // счёта, ради которой хеш и выбран вместо маски.
      const plain = asObject(redactKeys({ email: 'user@example.com' })).email;
      const noisy = asObject(redactKeys({ email: '  User@Example.COM ' })).email;

      expect(noisy).toBe(plain);
    });

    it('почта во вложенном объекте хешируется тоже', () => {
      const out = asObject(redactKeys({ payload: { email: 'user@example.com' } }));

      expect(asObject(out.payload).email).toMatch(/^\[Hashed: [0-9a-f]{12}\]$/);
      expect(JSON.stringify(out)).not.toContain('user@example.com');
    });

    it('`emailConfirmToken` стирается целиком, а не хешируется', () => {
      // Секретная маска проверяется раньше персональной: это секрет, а не почта,
      // и он не нужен для разбора вовсе.
      const out = asObject(redactKeys({ emailConfirmToken: 'real-confirm-token' }));

      expect(out.emailConfirmToken).toBe('[Filtered]');
    });

    it('пустое и пробельное значение стирается, а не хешируется', () => {
      // Хеш пустой строки — константа, одинаковая у всех: клиент, шлющий пустое
      // поле, дал бы в событиях одного настойчивого пользователя вместо многих.
      const empty = asObject(redactKeys({ email: '' }));
      const blank = asObject(redactKeys({ email: '   ' }));

      expect(empty.email).toBe('[Filtered]');
      expect(blank.email).toBe('[Filtered]');
    });

    it('нестроковое значение под ключом `email` стирается, а не хешируется', () => {
      // `String({})` дал бы стабильный хеш от `[object Object]`, то есть
      // ложное «это все один человек».
      const out = asObject(redactKeys({ email: { nested: 'user@example.com' } }));

      expect(out.email).toBe('[Filtered]');
      expect(JSON.stringify(out)).not.toContain('user@example.com');
    });
  });

  describe('LEGACY-332: расширенный состав секретной маски', () => {
    it.each(['credential', 'signature', 'jwt', 'session', 'apikey', 'api_key', 'api-key'])(
      'ключ `%s` маскируется',
      (key) => {
        const out = asObject(redactKeys({ [key]: 'leaked-value' }));

        expect(out[key]).toBe('[Filtered]');
      },
    );

    it('слово `key` само по себе маской не является', () => {
      // `key` совпало бы с `monkey`, `keyword` и с законным query-параметром
      // `key` в `POST /uploads/confirm` и `DELETE /uploads` — там это имя объекта
      // в хранилище, единственное, по чему разбирается сбой заливки.
      const out = asObject(redactKeys({ key: 'uploads/audio/x.mp3', monkey: 'ok' }));

      expect(out.key).toBe('uploads/audio/x.mp3');
      expect(out.monkey).toBe('ok');
    });

    it('слово `otp` само по себе маской не является', () => {
      const out = asObject(redactKeys({ notPublished: true, notPurchased: false }));

      expect(out.notPublished).toBe(true);
      expect(out.notPurchased).toBe(false);
    });
  });

  it('ключ `__proto__` остаётся собственным и не подменяет прототип', () => {
    // `JSON.parse` заводит `__proto__` обычным собственным ключом, и `Object.keys`
    // его отдаёт. Присваивание в литерал `{}` ушло бы в сеттер `Object.prototype`:
    // ключ пропал бы, а прототипом клона стало бы разобранное тело запроса.
    const body = JSON.parse('{"__proto__":{"leakMe":"raw-value"},"other":"y"}') as unknown;

    const out = asObject(redactKeys(body));

    expect(Object.keys(out)).toEqual(['__proto__', 'other']);
    expect(out.other).toBe('y');
    // Значение не утекло в прототип: наследованного `leakMe` у клона нет.
    expect((out as { leakMe?: unknown }).leakMe).toBeUndefined();
  });
});

describe('redactUrl', () => {
  it('маскирует значение секретного параметра строки запроса', () => {
    const out = redactUrl('/users/me?page=1&token=leaked-query-token');

    expect(out).not.toContain('leaked-query-token');
    // Путь и несекретные параметры остаются: без них событие бесполезно.
    expect(out).toContain('/users/me');
    expect(out).toContain('page=1');
  });

  it('адрес без строки запроса остаётся целым', () => {
    expect(redactUrl('/auth/login')).toBe('/auth/login');
  });

  it('секретный ключ, записанный процентным кодированием, тоже маскируется', () => {
    // `to%6Ben` — это `token`. Разбор его раскодирует, замена по строке нет.
    const out = redactUrl('/x?to%6Ben=leaked-encoded-token');

    expect(out).not.toContain('leaked-encoded-token');
  });

  it('повторяющийся секретный параметр маскируется во всех вхождениях', () => {
    const out = redactUrl('/x?token=first-leak&token=second-leak');

    expect(out).not.toContain('first-leak');
    expect(out).not.toContain('second-leak');
  });

  it('пустая строка запроса не оставляет висячий вопросительный знак', () => {
    expect(redactUrl('/x?')).toBe('/x');
  });

  describe('LEGACY-332: почта в строке запроса', () => {
    it('значение `email` уходит хешем, а не открытым текстом', () => {
      const out = redactUrl('/auth/login?email=user@example.com&page=1');

      expect(out).not.toContain('user%40example.com');
      expect(out).not.toContain('user@example.com');
      expect(out).toContain('page=1');
      expect(out).toMatch(/email=%5BHashed%3A\+[0-9a-f]{12}%5D/);
    });

    it('повторяющийся `email` хешируется по каждому вхождению отдельно', () => {
      // `params.set` заменил бы все вхождения первым значением, и вторая почта
      // пропала бы бесследно — потерялся бы счёт разных пострадавших.
      const out = redactUrl('/x?email=one@example.com&email=two@example.com&page=1');

      const hashes = out.match(/%5BHashed%3A\+[0-9a-f]{12}%5D/g) ?? [];
      expect(hashes).toHaveLength(2);
      expect(hashes[0]).not.toBe(hashes[1]);
      expect(out).toContain('page=1');
      expect(out).not.toContain('one@example.com');
      expect(out).not.toContain('two@example.com');
    });

    it('пустое значение `email` в адресе стирается, а не даёт хеш пустой строки', () => {
      const out = redactUrl('/x?email=');

      expect(out).toContain('%5BFiltered%5D');
      expect(out).not.toContain('Hashed');
    });

    it('хеш из адреса совпадает с хешем из тела', () => {
      // Иначе одно и то же событие давало бы два разных «человека».
      const fromUrl = redactUrl('/x?email=user@example.com');
      const fromBody = (redactKeys({ email: 'user@example.com' }) as Record<string, unknown>)
        .email as string;
      const digest = fromBody.replace(/^\[Hashed: |\]$/g, '');

      expect(fromUrl).toContain(digest);
    });
  });
});
