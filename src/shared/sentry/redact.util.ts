import { createHash } from 'node:crypto';

/**
 * Редактор значений, уезжающих во внешний сервис вместе с событием Sentry
 * (`LEGACY-115`, `LEGACY-188`, `LEGACY-331`, `LEGACY-332`).
 *
 * Вынесен из `sentry.filter.ts` 30.08.2026: ни одна из этих функций не читает
 * состояние фильтра, а проверять их через мок `ArgumentsHost` и области событий
 * дороже, чем прямым вызовом.
 */

/**
 * Ключи, значения которых не уезжают во внешний сервис (`LEGACY-115`).
 *
 * 🔴 Маска существует с самого начала, но применялась только к телу запроса,
 * а `headers`, `query` и `params` уходили в событие как есть. В заголовках
 * лежат `Authorization` с рабочим JWT и `Cookie` с сессией, то есть в проекте
 * Sentry оседали действующие токены доступа тех, чей запрос упал с 5xx.
 *
 * ⚠️ Регистр не важен: Express отдаёт имена заголовков в нижнем регистре
 * (`authorization`, `cookie`), а тело запроса приходит в чужом регистре
 * (`Authorization`, `accessToken`), и оба случая закрывает флаг `i`.
 *
 * ⚠️ Совпадение частичное и это намеренно: `accessToken`, `refresh_token`,
 * `set-cookie` и `proxy-authorization` попадают под маску сами.
 *
 * ⚠️ Шесть слов добавлены 30.08.2026 решением арбитра (`LEGACY-332`). Слова
 * `key` и `otp` в список **не** взяты намеренно: `key` совпадает с `monkey`
 * и `keyword`, а заодно с законным query-параметром `key` в `POST /uploads/confirm`
 * и `DELETE /uploads` (`uploads.controller.ts`) — там это имя объекта в хранилище,
 * единственное, по чему разбирается сбой заливки, а не секрет; `otp`
 * совпадает с `notPublished` и `notPurchased`. Маскировать несуществующее
 * сегодня поле ценой потери живой диагностики — плохой обмен.
 */
const SENSITIVE_KEY_PATTERN =
  /password|token|authorization|secret|cookie|credential|signature|jwt|session|apikey|api[-_]key/i;

/**
 * Ключи, значения которых уезжают в событие **хешем, а не открытым текстом**
 * (`LEGACY-332`).
 *
 * 🔴 Это не секреты, а персональные данные, и разница определяет обращение.
 * Секрет надо стереть: он не нужен для разбора вовсе. Почта нужна — но не сама,
 * а лишь как ответ на вопрос «упало у одного человека двести раз или у двухсот
 * человек по разу». Хеш этот вопрос закрывает, а личность не выдаёт.
 *
 * ⚠️ Проверяется **после** `SENSITIVE_KEY_PATTERN`, а не до: `emailConfirmToken`
 * попадает под оба, и это секрет, а не почта, — он должен стираться целиком.
 *
 * ⚠️ Почему второй канал вообще существовал: `LEGACY-187` закрыл только `setUser`,
 * а тело `POST /auth/login`, упавшего в 500, клало в событие открытую почту рядом
 * с маршрутом и `ip`. На входе пользователь ещё не вошёл, `setUser` пуст, и почта
 * в теле — единственное, что отличает один упавший вход от другого.
 */
const PERSONAL_KEY_PATTERN = /email/i;

/**
 * Сколько шестнадцатеричных знаков хеша уходит в событие (`LEGACY-332`).
 *
 * ⚠️ Двенадцати хватает, чтобы совпадение двух разных почт в пределах одного
 * разбора инцидента было невероятным, и мало, чтобы значение выглядело
 * пригодным к чему-то, кроме сравнения на равенство.
 */
const HASH_PREFIX_LENGTH = 12;

/**
 * Хеш **несолёный** и оттого стабильный между перезапусками и инстансами:
 * счёт уникальных пострадавших иначе не сходится. Соль из окружения — тема
 * владельца, а соль на процесс после рестарта в цикле падений даёт уверенно
 * неверный счёт. Решение арбитра от 30.08.2026.
 *
 * ⚠️ Нормализация обязательна: `User@Example.COM ` и `user@example.com` — один
 * человек, и без `trim().toLowerCase()` они дали бы два разных хеша, то есть
 * ровно ту ошибку счёта, ради которой хеш и выбран вместо маски.
 */
function hashPersonalValue(value: string): string {
  const normalized = value.trim().toLowerCase();
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex');
  return `[Hashed: ${digest.slice(0, HASH_PREFIX_LENGTH)}]`;
}

/**
 * Обращение с ключом по его имени: секрет стирается, персональное уходит хешем,
 * остальное отдаётся на обычный обход.
 *
 * 🔴 Помощник один на оба цикла — по ключам объекта и по параметрам строки
 * запроса — намеренно. Написанный дважды, этот разбор разъезжается при первой же
 * правке: новое правило обращения с почтой легло бы в цикл по объекту и не дошло
 * до строки запроса, и тогда `body` и `url` одного события дали бы по одной
 * и той же почте два разных значения, то есть двух «людей» вместо одного.
 * Найдено ревью 30.08.2026 до коммита.
 *
 * ⚠️ Порядок проверок обязателен: `emailConfirmToken` попадает под обе маски,
 * и это секрет, а не почта.
 *
 * ⚠️ Нестроковое значение под персональным ключом (объект, массив, число) — это
 * не почта, а неизвестно что: нормализовать его нечем, а `String(value)` дал бы
 * стабильный хеш от `[object Object]`, то есть ложное «это все один человек».
 * Такое значение стирается.
 */
function redactByKey(key: string, value: unknown): { handled: true; value: string } | undefined {
  if (SENSITIVE_KEY_PATTERN.test(key)) return { handled: true, value: '[Filtered]' };
  if (!PERSONAL_KEY_PATTERN.test(key)) return undefined;
  return { handled: true, value: redactPersonalValue(value) };
}

/**
 * ⚠️ Пустое и пробельное значение хешу не отдаётся. Хеш пустой строки —
 * константа, одинаковая у всех: клиент, отправляющий пустое поле, дал бы
 * в событиях один и тот же `[Hashed: e3b0c44298fc]`, и разбор увидел бы
 * одного настойчивого пользователя вместо множества разных. Ровно та же
 * причина, по которой стирается нестроковое значение.
 * Найдено ревью 30.08.2026 до коммита.
 */
function redactPersonalValue(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return '[Filtered]';
  return hashPersonalValue(value);
}

/**
 * Предел глубины обхода в `redactKeys` (`LEGACY-188`). Вход — уровень 1.
 *
 * ⚠️ Четыре, а не пять: все наблюдаемые формы мельче (`{ user: { password } }`
 * и `?filter[token]=` — второй уровень), а меньшая глубина ошибается
 * в безопасную сторону. Непройденный контейнер заменяется меткой и утечь
 * не может; теряется только диагностика. Решение арбитра от 30.08.2026.
 */
const MAX_REDACT_DEPTH = 4;

/**
 * Сколько элементов массива уходит в событие целиком (`LEGACY-188`).
 *
 * ⚠️ Событие Sentry имеет предел размера и обрезается молча, теряя как раз
 * хвост. Явный потолок с меткой об усечении отличает «их было больше»
 * от «столько и было».
 */
const MAX_REDACT_ARRAY_ITEMS = 20;

/**
 * Общий редактор ключей для всего, что кладётся в контекст события.
 *
 * ⚠️ Любое новое поле контекста обязано проходить через него — это записано
 * правилом в `LEGACY-115`, потому что заголовки миновали маску ровно так:
 * поле добавили рядом с уже замаскированным телом и сочли вопрос закрытым.
 *
 * ⚠️ Проход **рекурсивный** с 30.08.2026 (`LEGACY-188`): вложенное
 * `{ user: { password } }` и `{ items: [{ token }] }` чистятся тоже.
 * До этого проход был по верхнему уровню, и вложенный секрет уезжал
 * во внешний сервис целиком.
 */
export function redactKeys(value: unknown): unknown {
  return redactValue(value, 1, new Set<object>());
}

/**
 * Адрес события без значений секретных параметров строки запроса (`LEGACY-189`).
 *
 * 🔴 Редактор ключей сюда неприменим по форме: он маскирует ключи объекта, а
 * `req.originalUrl` — текст. Без этого разбора значение, замаскированное в
 * `query`, тем же событием уезжало открытым в `url` и вторым разом в хлебной
 * крошке, то есть маска на `query` закрывала одно место из трёх.
 *
 * ⚠️ Разбором, а не регуляркой по строке: параметр может повторяться, быть
 * пустым и содержать процентное кодирование. Путь не трогаем — без него
 * событие бесполезно.
 *
 * ⚠️ Персональные ключи обрабатываются здесь так же, как в теле (`LEGACY-332`):
 * иначе почта, ушедшая хешем из `body`, уезжала бы открытой из строки запроса.
 */
export function redactUrl(rawUrl: string): string {
  const queryStart = rawUrl.indexOf('?');
  if (queryStart === -1) return rawUrl;

  const pathPart = rawUrl.slice(0, queryStart);
  const params = new URLSearchParams(rawUrl.slice(queryStart + 1));
  for (const key of Array.from(new Set(params.keys()))) {
    // `?email=` в адресе — та же почта, что и в теле, и уезжает она дважды:
    // в `url` контекста и в хлебной крошке (`LEGACY-189`). Обращение одно.
    const replaced: string[] = [];
    for (const value of params.getAll(key)) {
      const item = redactByKey(key, value);
      if (item) replaced.push(item.value);
    }
    if (replaced.length === 0) continue;

    // 🔴 Каждое вхождение обрабатывается своим значением, а не первым на все.
    // `params.set` заменяет все вхождения разом: на `?email=a&email=b` вторая
    // почта пропадала бы бесследно — то есть терялся ровно тот счёт разных
    // пострадавших, ради которого выбран хеш. Для секретов это было незаметно:
    // все вхождения превращаются в одинаковый `[Filtered]`.
    // Найдено ревью 30.08.2026 до коммита.
    params.delete(key);
    for (const value of replaced) params.append(key, value);
  }
  const query = params.toString();
  return query ? `${pathPart}?${query}` : pathPart;
}

/**
 * Один узел обхода: `depth` — уровень самого `value`, вход равен 1.
 *
 * ⚠️ Предел глубины проверяется **только для контейнеров**. Скаляр на любом
 * уровне уже прошёл проверку имени в цикле родителя, поэтому обрезать его
 * незачем — это стоило бы диагностики без выигрыша. Контейнер же обрезается
 * обязательно: его ключи мы не смотрели и поручиться за них не можем.
 *
 * ⚠️ `seen` — множество **текущего пути**, а не всего обхода: объект
 * добавляется перед спуском и снимается после. Глобальное множество сочло
 * бы циклом повторную ссылку на один объект из двух соседних ключей
 * и молча съело бы содержимое второй.
 */
function redactValue(value: unknown, depth: number, seen: Set<object>): unknown {
  const binary = describeBinary(value);
  if (binary) return binary;

  const container = getContainer(value);
  if (!container) return value;
  if (depth > MAX_REDACT_DEPTH) return '[MaxDepth]';

  if (seen.has(container)) return '[Circular]';
  seen.add(container);
  try {
    return Array.isArray(container)
      ? redactArray(container, depth, seen)
      : redactObject(container, depth, seen);
  } finally {
    seen.delete(container);
  }
}

/**
 * ⚠️ Ключ, совпавший с маской, заменяется целиком и **внутрь не заходим**:
 * так `authorization` с объектным значением остаётся `[Filtered]`, как было
 * до рекурсии, и ошибка тут в безопасную сторону.
 *
 * 🔴 Клон строится через `Object.create(null)`, а не литералом `{}`. `JSON.parse`
 * заводит `__proto__` обычным собственным ключом, и `Object.keys` его отдаёт;
 * но присваивание `clone['__proto__']` объекту с обычным прототипом уходит
 * в сеттер `Object.prototype.__proto__` — собственного ключа не появляется,
 * значение пропадает, а прототипом клона становится разобранное тело запроса.
 * Тело без прототипа сеттера не имеет, и присваивание кладёт обычный ключ.
 * Снятый спред `{ ...value }` этим не страдал, поэтому переход на цикл был
 * регрессией; найдено ревью 30.08.2026 до коммита.
 */
function redactObject(
  value: Record<string, unknown>,
  depth: number,
  seen: Set<object>,
): Record<string, unknown> {
  const clone = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    const replaced = redactByKey(key, value[key]);
    clone[key] = replaced ? replaced.value : redactValue(value[key], depth + 1, seen);
  }
  return clone;
}

function redactArray(value: unknown[], depth: number, seen: Set<object>): unknown[] {
  const kept = value
    .slice(0, MAX_REDACT_ARRAY_ITEMS)
    .map((item) => redactValue(item, depth + 1, seen));
  const dropped = value.length - MAX_REDACT_ARRAY_ITEMS;
  if (dropped > 0) kept.push(`[Truncated: ${dropped} more]`);
  return kept;
}

/** Значение, внутрь которого редактор заходит: массив или простой объект. */
function getContainer(value: unknown): unknown[] | Record<string, unknown> | undefined {
  // `Array.isArray` сужает `unknown` до `any[]`, а не до `unknown[]` — приведение
  // возвращает проверку типов внутрь элементов, а не отключает её.
  if (Array.isArray(value)) return value as unknown[];
  return isPlainObject(value) ? value : undefined;
}

/**
 * 🔴 Двоичное тело внутрь редактора не пускается вовсе.
 *
 * На `POST /uploads/direct` тело разбирается сырым `express.raw` с любым типом
 * содержимого, то есть `req.body` там — `Buffer` размером
 * до `UPLOADS_MAX_AUDIO_MB + 10` (по умолчанию 210 МБ).
 * `Array.isArray(Buffer)` ложно, а `isPlainObject` истинно, поэтому редактор
 * разворачивал бы его в объект «ключ на байт» — сотни миллионов ключей, собираемых
 * внутри обработчика исключения, и потолок `MAX_REDACT_ARRAY_ITEMS` сюда не достаёт.
 * Проверка стоит **до** `getContainer` и отдаёт только размер: содержимое файла
 * в событии не нужно, а знать, что тело было двоичным и каким, — нужно.
 * Найдено ревью 30.08.2026 до коммита.
 */
function describeBinary(value: unknown): string | undefined {
  if (ArrayBuffer.isView(value)) return `[Binary: ${value.byteLength} bytes]`;
  if (value instanceof ArrayBuffer) return `[Binary: ${value.byteLength} bytes]`;
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
