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
      // Ключ `title`, а не `name`: последний с 30.08.2026 стирается точным
      // совпадением (`LEGACY-334`), и проверка про цикл краснела бы не по делу.
      const cyclic: Record<string, unknown> = { title: 'root' };
      cyclic.self = cyclic;

      const out = asObject(redactKeys(cyclic));

      expect(out.title).toBe('root');
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

  describe('LEGACY-335: носитель состояния вне перечислимых ключей', () => {
    it('`Date` отдаётся меткой со временем, а не пустым объектом', () => {
      const out = asObject(redactKeys({ at: new Date('2026-08-30T10:20:30.000Z') }));

      expect(out.at).toBe('[Date: 2026-08-30T10:20:30.000Z]');
    });

    it('негодная дата отдаётся меткой, а не роняет обход', () => {
      // Редактор зовётся внутри обработчика исключения: `toISOString` на негодной
      // дате бросает `RangeError`, и падать здесь нельзя.
      const out = asObject(redactKeys({ at: new Date('nonsense') }));

      expect(out.at).toBe('[Date: Invalid Date]');
    });

    it('`Map` и `Set` отдаются числом элементов', () => {
      const out = asObject(
        redactKeys({
          m: new Map([
            ['a', 1],
            ['b', 2],
          ]),
          s: new Set([1, 2, 3]),
        }),
      );

      expect(out.m).toBe('[Map: 2 entries]');
      expect(out.s).toBe('[Set: 3 entries]');
    });

    it('`RegExp` отдаётся своим текстом', () => {
      const out = asObject(redactKeys({ pattern: /ab+c/gi }));

      expect(out.pattern).toBe('[RegExp: ab+c]');
    });

    it('`Error` отдаётся именем класса, но не текстом и не стеком', () => {
      // В `message` и `stack` пишут свободно, и там регулярно оказывается
      // и почта, и токен — то есть ровно то, что редактор и убирает.
      const out = asObject(redactKeys({ cause: new TypeError('token=abc user@example.com') }));

      expect(out.cause).toBe('[Error: TypeError]');
    });

    it('неизвестный не-простой объект отдаётся именем конструктора, а не `{}`', () => {
      class Wallet {
        private readonly amount = 10;
        total(): number {
          return this.amount;
        }
      }

      const out = asObject(redactKeys({ w: new Wallet() }));

      expect(out.w).toBe('[Object: Wallet]');
    });

    it('объект без прототипа остаётся простым и разбирается по ключам', () => {
      // `req.headers` и `req.query` собираются через `Object.create(null)`:
      // метка вместо разбора съела бы заголовки и строку запроса целиком.
      const headers = Object.create(null) as Record<string, unknown>;
      headers.authorization = 'Bearer x';
      headers.accept = 'application/json';

      const out = asObject(redactKeys(headers));

      expect(out.authorization).toBe('[Filtered]');
      expect(out.accept).toBe('application/json');
    });

    it('массив меткой не подменяется', () => {
      // Прототип массива — не `Object.prototype`, и без отдельной проверки
      // редактор перестал бы заходить в массивы вовсе.
      expect(redactKeys({ items: [1, 2] })).toEqual({ items: [1, 2] });
    });

    it('собственный ключ `constructor` в метку не попадает', () => {
      // 🔴 Вход обязан быть **не простым** объектом, иначе `describeExotic` вернёт
      // `undefined` и `constructorName` не позовётся ни разу — проверка окажется
      // зелёной при любой её реализации (`L-004`). Поэтому собственный ключ
      // `constructor` кладётся на экземпляр класса, а не в разобранное тело.
      class Wallet {}
      const value = Object.assign(new Wallet(), { constructor: 'user@example.com' });

      const out = asObject(redactKeys({ w: value }));

      expect(out.w).toBe('[Object: Wallet]');
    });

    it('собственный ключ `constructor` в простом объекте разбирается как обычный', () => {
      // `JSON.parse` заводит `constructor` обычным собственным ключом; простой
      // объект до меток не доходит вовсе и обходится по ключам.
      const body = JSON.parse('{"constructor":"user@example.com"}') as Record<string, unknown>;
      const out = asObject(redactKeys({ nested: body }));

      expect(out.nested).toEqual({ constructor: 'user@example.com' });
    });

    it('двоичное значение остаётся размером, а не именем класса', () => {
      // Порядок проверок: `Buffer` тоже не простой объект, но про него нужен размер.
      expect(redactKeys(Buffer.alloc(8))).toBe('[Binary: 8 bytes]');
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

  describe('LEGACY-334: персональные поля заявителя не уезжают открытыми', () => {
    it('тело правовой заявки не выносит наружу ни имени, ни телефона, ни адреса', () => {
      // `POST /api/admin/rights/claims`, упавший в 500, клал в событие контакты
      // живого человека рядом с `ip` и тегом `route`. Заявитель DMCA — не пользователь
      // сайта и согласия на это не давал.
      const out = asObject(
        redactKeys({
          claimType: 'COPYRIGHT',
          claimantName: 'Иван Петров',
          claimantOrganization: 'ООО «Правообладатель»',
          claimantEmail: 'ivan@example.com',
          claimantPhone: '+79991234567',
          claimantAddress: 'г. Москва, ул. Ленина, 1',
        }),
      );

      expect(out.claimantName).toBe('[Filtered]');
      expect(out.claimantOrganization).toBe('[Filtered]');
      expect(out.claimantPhone).toBe('[Filtered]');
      expect(out.claimantAddress).toBe('[Filtered]');
      // Тип заявки персональным не является и остаётся: без него разбирать нечего.
      expect(out.claimType).toBe('COPYRIGHT');
      expect(JSON.stringify(out)).not.toContain('Иван');
      expect(JSON.stringify(out)).not.toContain('79991234567');
      expect(JSON.stringify(out)).not.toContain('Москва');
    });

    it('`claimantEmail` остаётся хешем, а не стирается словом `claimant`', () => {
      // Ключ попадает под обе персональные маски, и порядок решает: стёртая почта
      // заявителя убила бы счёт уникальных пострадавших, ради которого выбран хеш.
      const claim = asObject(redactKeys({ claimantEmail: 'ivan@example.com' }));
      const plain = asObject(redactKeys({ email: 'ivan@example.com' }));

      expect(claim.claimantEmail).toMatch(/^\[Hashed: [0-9a-f]{12}\]$/);
      expect(claim.claimantEmail).toBe(plain.email);
    });

    it.each(['claimantType', 'claimantIsAuthorized', 'claimantPersonId'])(
      '🔴 побочная цена слова `claimant`: ключ `%s` тоже стирается',
      (key) => {
        // Тип заявителя, флаг полномочий и идентификатор персоны — не персональные
        // данные, и диагностику они несут. Их стирание — принятая цена решения
        // арбитра, а не упущение, и проверка стоит здесь именно поэтому: сузь
        // кто-нибудь маску до перечисления шести полей DMCA — эти три открылись бы,
        // и без этой проверки не покраснело бы ничто.
        const out = asObject(redactKeys({ [key]: 'ORGANIZATION' }));

        expect(out[key]).toBe('[Filtered]');
      },
    );

    it('`counterNoticeClaimantName` стирается тоже', () => {
      const out = asObject(redactKeys({ counterNoticeClaimantName: 'Пётр Иванов' }));

      expect(out.counterNoticeClaimantName).toBe('[Filtered]');
    });

    it.each(['phone', 'organization', 'fullName', 'fullname', 'firstName', 'lastName', 'nickname'])(
      'ключ `%s` стирается',
      (key) => {
        const out = asObject(redactKeys({ [key]: 'Иван Петров' }));

        expect(out[key]).toBe('[Filtered]');
      },
    );

    it('`emailConfirmToken` остаётся секретом, а не хешем', () => {
      // Порядок трёх проверок: секретная маска идёт первой и по сырому имени.
      const out = asObject(redactKeys({ emailConfirmToken: 'raw-token' }));

      expect(out.emailConfirmToken).toBe('[Filtered]');
    });
  });

  describe('LEGACY-334: персональная маска сверяется со словами ключа, а не с подстрокой', () => {
    it('`voicemailNumber` не выдаётся за почту', () => {
      // До 30.08.2026 `/email/i` совпадало с `voicemail`, и телефон уезжал
      // бессмысленным почтовым хешем — значение было неверным уже сегодня.
      const out = asObject(redactKeys({ voicemailNumber: '+15551234567' }));

      expect(out.voicemailNumber).toBe('+15551234567');
    });

    it.each(['email', 'userEmail', 'claimantEmail', 'byEmail', 'contact_email'])(
      'ключ `%s` почтой считается',
      (key) => {
        const out = asObject(redactKeys({ [key]: 'user@example.com' }));

        expect(out[key]).toMatch(/^\[Hashed: [0-9a-f]{12}\]$/);
      },
    );

    it('череда заглавных разрезается: `APIEmail` — это почта', () => {
      const out = asObject(redactKeys({ APIEmail: 'user@example.com' }));

      expect(out.APIEmail).toMatch(/^\[Hashed: [0-9a-f]{12}\]$/);
    });

    it.each([
      ['fileName', 'claim-scan.pdf'],
      ['sourceFileName', 'report.xml'],
      ['agentName', 'rights-agent/1.2'],
      ['eventName', 'Ярмарка'],
      ['roleName', 'ADMIN'],
      ['originalname', 'scan.pdf'],
      ['authorName', 'Лев Толстой'],
      ['streetAddress', 'Baker Street 221B'],
      ['addressLocality', 'London'],
    ])('ключ `%s` остаётся открытым: маску съела бы живая диагностика', (key, value) => {
      const out = asObject(redactKeys({ [key]: value }));

      expect(out[key]).toBe(value);
    });

    it('слово `claimant` целиком, а не его часть', () => {
      const out = asObject(redactKeys({ claimant_note: 'x', reclaimantion: 'y' }));

      expect(out.claimant_note).toBe('[Filtered]');
      expect(out.reclaimantion).toBe('y');
    });

    it('🔴 множественное число словом не считается и под маску не попадает', () => {
      // Сверка идёт со словом целиком, поэтому `claimants`, `phones`
      // и `organizations` маской НЕ покрыты. Это не описка, а прямое следствие
      // выбранного правила совпадения, и знать о нём надо до того, как в правовой
      // ручке заведут `claimants: [{ name, phone }]`: такой ключ уедет открытым.
      const out = asObject(
        redactKeys({ claimants: ['Иван Петров'], phones: ['+7999'], organizations: ['ООО'] }),
      );

      expect(out.claimants).toEqual(['Иван Петров']);
      expect(out.phones).toEqual(['+7999']);
      expect(out.organizations).toEqual(['ООО']);
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

describe('LEGACY-334: точный ключ `name`', () => {
  function asObject(value: unknown): Record<string, unknown> {
    return value as Record<string, unknown>;
  }

  it('имя человека из тела регистрации не уезжает открытым', () => {
    // `POST /api/auth/register`, упавший в 500, клал в событие имя рядом с уже
    // хешированной почтой и `ip` — сценарий `LEGACY-332`, только именем.
    const out = asObject(
      redactKeys({ email: 'ivan@example.com', password: 'x', name: 'Иван Петров' }),
    );

    expect(out.name).toBe('[Filtered]');
    expect(out.password).toBe('[Filtered]');
    expect(out.email).toMatch(/^\[Hashed: [0-9a-f]{12}\]$/);
  });

  it.each(['fileName', 'agentName', 'eventName', 'roleName', 'authorName', 'displayName'])(
    'ключ `%s` точным совпадением не задет и остаётся открытым',
    (key) => {
      // Цена слова `name` — 26 живых ключей диагностики; точный ключ гасит один.
      const out = asObject(redactKeys({ [key]: 'значение' }));

      expect(out[key]).toBe('значение');
    },
  );
});

describe('LEGACY-334: белый список ключей', () => {
  function asObject(value: unknown): Record<string, unknown> {
    return value as Record<string, unknown>;
  }

  const allow: ReadonlySet<string> = new Set(['claim_type', 'status', 'book_version_id', 'id']);

  it('обязательная проза правовой заявки не уезжает, а перечисленное остаётся', () => {
    // Встречное уведомление DMCA по своей форме и есть контактный блок отправителя:
    // имя, адрес и телефон лежат в нём текстом, под именем ключа, которое
    // персональным не назовёшь. Маска по ключу его не берёт никогда.
    const out = asObject(
      redactKeys(
        {
          claimType: 'COPYRIGHT',
          status: 'OPEN',
          bookVersionId: 'bv-1',
          counterNoticeTextRu: 'Я, Иван Петров, +79991234567, г. Москва, ул. Ленина, 1',
          descriptionRu: 'произвольный текст',
          originalNoticeText: 'контактный блок заявителя',
        },
        allow,
      ),
    );

    expect(out.claimType).toBe('COPYRIGHT');
    expect(out.status).toBe('OPEN');
    expect(out.bookVersionId).toBe('bv-1');
    expect(out.counterNoticeTextRu).toBe('[Filtered]');
    expect(out.descriptionRu).toBe('[Filtered]');
    expect(out.originalNoticeText).toBe('[Filtered]');
    expect(JSON.stringify(out)).not.toContain('Иван');
    expect(JSON.stringify(out)).not.toContain('79991234567');
  });

  it('без списка та же проза уезжает открытой — список и есть единственный механизм', () => {
    const out = asObject(redactKeys({ counterNoticeTextRu: 'Я, Иван Петров, +79991234567' }));

    expect(out.counterNoticeTextRu).toBe('Я, Иван Петров, +79991234567');
  });

  it('🔴 список не вправе снять маску с уже совпавшего ключа', () => {
    // Иначе достаточно было бы внести имя в список, чтобы вернуть наружу секрет.
    const wide: ReadonlySet<string> = new Set(['password', 'claimant_name', 'name', 'email']);

    const out = asObject(
      redactKeys(
        { password: 'plaintext', claimantName: 'Иван', name: 'Пётр', email: 'a@b.c' },
        wide,
      ),
    );

    expect(out.password).toBe('[Filtered]');
    expect(out.claimantName).toBe('[Filtered]');
    expect(out.name).toBe('[Filtered]');
    expect(out.email).toMatch(/^\[Hashed: [0-9a-f]{12}\]$/);
  });

  it('🔴 список доезжает до вложенного уровня через разрешённый ключ', () => {
    // Проверка стоит на разрешённом ключе-контейнере намеренно. Через
    // неразрешённый (`nested`) внутрь не заходят вовсе — он гаснет на верхнем
    // уровне, и параметр `allow`, проведённый в `redactValue`/`redactObject`/
    // `redactArray`, ни разу не понадобился бы: снятие его из всех трёх
    // рекурсивных вызовов оставило бы спеку зелёной (`L-004`).
    //
    // Достижимо до `ValidationPipe`: гварды выполняются раньше пайпов, и 500
    // из `RolesGuard` при недоступной базе кладёт в событие сырое тело клиента —
    // любой формы, в том числе объект под именем разрешённого ключа.
    const out = asObject(
      redactKeys({ id: { descriptionRu: 'Я, Иван Петров, +79991234567' } }, allow),
    );

    expect(asObject(out.id).descriptionRu).toBe('[Filtered]');
    expect(JSON.stringify(out)).not.toContain('Иван');
  });

  it('🔴 список доезжает и до элемента массива под разрешённым ключом', () => {
    // Вторая рекурсивная ветка: `redactArray`. Без переданного `allow` содержимое
    // элемента ушло бы открытым.
    const out = asObject(redactKeys({ id: [{ descriptionRu: 'проза' }] }, allow));

    const items = out.id as Record<string, unknown>[];
    expect(items[0].descriptionRu).toBe('[Filtered]');
  });

  it('неразрешённый ключ гаснет целиком, внутрь не заходя', () => {
    const out = asObject(redactKeys({ status: 'OPEN', nested: { descriptionRu: 'проза' } }, allow));

    expect(out.status).toBe('OPEN');
    expect(out.nested).toBe('[Filtered]');
  });

  it('в строке запроса действует тот же список, что и в теле', () => {
    // Врозь их пускать нельзя: закрытое в теле и открытое в адресе уезжает
    // вторым каналом — это дефект `LEGACY-189`.
    const out = redactUrl('/api/admin/rights/claims?status=OPEN&q=Иван%20Петров', allow);

    expect(out).toContain('status=OPEN');
    expect(out).toContain('q=%5BFiltered%5D');
    expect(decodeURIComponent(out)).not.toContain('Иван');
  });
});
