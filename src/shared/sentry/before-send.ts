import type { ErrorEvent } from '@sentry/node';

import { redactFreeText, redactKeys, redactUrl, type RedactAllowList } from './redact.util';
import { ALLOW_LIST_PATH_PATTERN, RIGHTS_ALLOW_LIST } from './rights-allow-list';

/**
 * Редактор **самого события**, а не его контекста (`LEGACY-336`).
 *
 * 🔴 До 01.09.2026 `Sentry.captureException(exception)` (`sentry.filter.ts`)
 * уходил мимо редактора целиком: `beforeSend` в `Sentry.init` не было, единой
 * точки, через которую проходили бы все события, не существовало. Вся правка
 * значений жила внутри `SentryExceptionFilter` и покрывала только контекст.
 * В одном и том же событии `body.claimantAddress` был `[Filtered]` белым
 * списком, а `exception.value` — тот же адрес открытой строкой:
 * `PrismaClientValidationError.message` — это отрисованный вызов **вместе
 * со всем объектом `data`**.
 *
 * ⚠️ Точка приложения — именно `beforeSend`, а не фильтр: через фильтр проходят
 * не все события, а `beforeSend` — единственный хук клиента, через который
 * проходит каждое.
 *
 * ⚠️ Функция живёт отдельным файлом и экспортируется, а в `main.ts` уходит
 * только ссылка на неё. Причина не в красоте: `main.ts` не покрыт ни одним
 * тестом (`bootstrap()` не экспортируется), а обе спеки Sentry подменяют
 * `@sentry/node` целиком через `jest.mock`. Колбэк, записанный прямо
 * в `Sentry.init`, не исполнился бы ни в одной проверке — то есть посадки
 * на нём не существует.
 *
 * ⚠️ Модуль обязан оставаться **чистым**: ни `@nestjs/*`, ни `sentry.filter.ts`
 * он не импортирует. Шаблон маршрута берётся из `rights-allow-list.ts` —
 * общего предка, который тоже ничего не знает ни про Nest, ни про запрос.
 */

/**
 * Потолок длины строки, задаваемый клиенту Sentry (`LEGACY-336`).
 *
 * 🔴 По умолчанию SDK ставит `maxValueLength = 250` и режет `event.message`,
 * `exception.value` и `request.url` **до** `beforeSend`: `_prepareEvent`
 * (`@sentry/core/baseclient.js:607`) идёт раньше `processBeforeSend` (`:619`).
 * Рез идёт по числу знаков и приходится посреди адреса почты — приезжает
 * обрывок `ceo@exam...`, которого `EMAIL_VALUE_PATTERN` не ловит, и локальная
 * часть адреса уезжает открытой. А локальная часть корпоративной почты
 * регулярно и есть имя с фамилией.
 *
 * ⚠️ Это ровно тот дефект, который сам редактор уже признал недопустимым
 * и закрыл порядком «сначала хеш, потом потолок» (`redact.util.ts`). Держать
 * его внутри правки, объявляющей канал закрытым, нельзя.
 *
 * Отсюда 8192: потолок поднят заведомо выше собственного `MAX_FREE_TEXT_LENGTH`,
 * поэтому шов от SDK всегда лежит **за** нашим потолком и снимается нашим же
 * усечением до отправки. Инвариант `SENTRY_MAX_VALUE_LENGTH > MAX_FREE_TEXT_LENGTH`
 * держится спекой, а не глазами: `main.ts` тестом не покрыт.
 * Решение арбитра от 01.09.2026.
 */
export const SENTRY_MAX_VALUE_LENGTH = 8192;

/**
 * Сколько строк сообщения исключения доезжает до события.
 *
 * 🔴 Одна. `PrismaClientValidationError.message` начинается именем операции
 * (`Invalid \`prisma.rightsClaim.create()\` invocation in …`), а со следующих
 * строк идёт дамп аргументов: там и лежат `claimantName`, адрес и телефон.
 * Имя операции — единственное, ради чего сообщение и читают; дамп разбору
 * не нужен и заменяется меткой. Решение арбитра от 01.09.2026.
 */
function cutToFirstLine(text: string): string {
  // 🔴 Ведущие пустые строки отбрасываются до реза, и это не косметика.
  // Настоящее `PrismaClientValidationError.message` **начинается** с перевода
  // строки: сборщик в `@prisma/client/runtime/client.js` заводит массив как
  // `let a = ['']` и отдаёт `a.join('\n')`. Без этой строки `search` вернул бы
  // ноль, `slice(0, 0)` — пустую строку, и от текста исключения не осталось бы
  // ничего: событие есть, разбирать нечем. Найдено ревью 01.09.2026, проверено
  // чтением исходника рантайма.
  const body = text.replace(/^[\r\n]+/, '');
  const lineEnd = body.search(/\r?\n/);
  if (lineEnd === -1) return body;
  // Считается снятое **содержимое**, без самого разделителя: иначе метка
  // завышена на его длину и «сколько потеряно» перестаёт сходиться.
  const dropped = body.slice(lineEnd).replace(/^\r?\n/, '').length;
  if (dropped === 0) return body.slice(0, lineEnd);
  return `${body.slice(0, lineEnd)}[Truncated: ${dropped} more chars]`;
}

function redactEventText(text: string): string {
  return redactFreeText(cutToFirstLine(text));
}

/**
 * Белый список для полей `event.request`, выбранный по адресу самого события.
 *
 * 🔴 Отказ **в строгую сторону**: адреса нет или он не разобран — список
 * применяется. Здесь нельзя ошибиться в другую сторону: не тот выбор означает
 * не потерю диагностики, а отправку правовой заявки наружу целиком.
 * Решение арбитра от 01.09.2026.
 */
function allowListForUrl(url: unknown): RedactAllowList | undefined {
  if (typeof url !== 'string' || url === '') return RIGHTS_ALLOW_LIST;
  return ALLOW_LIST_PATH_PATTERN.test(url) ? RIGHTS_ALLOW_LIST : undefined;
}

/**
 * `beforeSend` клиента Sentry: обходит текст исключения, сообщение и `event.request`.
 *
 * 🔴 `event.request` правится потому, что `integrations: []` в `Sentry.init`
 * набора по умолчанию **не отключает**: `defaultIntegrations` — отдельный ключ,
 * и при `undefined` он заполняется целиком (`@sentry/node/sdk/index.js:237-239`).
 * В набор входит `requestDataIntegration`, кладущий `cookies`, `data`, `headers`,
 * `query_string` и `url` (`@sentry/core/integrations/requestdata.js:6-20`).
 * Сегодня эти поля пусты только потому, что `Sentry.init` вызван **после**
 * `NestFactory.create` и патч инструментации `http` не встаёт, — то есть
 * по незаписанной случайности порядка двух строк в `main.ts`. Любой перенос
 * `init` вверх, которого сам SDK и требует, отправил бы сырое тело заявки
 * и рабочий `authorization` мимо белого списка и мимо этой функции.
 * Найдено ревью 01.09.2026; решение арбитра того же дня.
 *
 * ⚠️ Функция **тотальна**: событие приходит из чужого кода, и бросок отсюда
 * потерял бы событие целиком вместе с отказом, ради которого оно и собрано.
 * Отсюда опциональные цепочки и проверки формы вместо доверия типам.
 *
 * ⚠️ Гонять `event` целиком через `redactKeys` **нельзя**: это стёрло бы
 * `stacktrace` и упёрлось бы в предел глубины на уже отредактированном
 * контексте. Правятся ровно пять полей `event.request` — свежий, никем
 * не тронутый ввод. Границы решения арбитра от 01.09.2026.
 *
 * ⚠️ `stacktrace` не трогается, но причина не та, что стояла здесь до
 * 01.09.2026: дело не в `integrations: []`, а в невыставленном
 * `includeLocalVariables` (`@sentry/node/integrations/local-variables-async.js:112`) —
 * без него у кадров нет `vars`. `contexts`, `tags`, `breadcrumbs` и `user` уже
 * прошли редактор в `sentry.filter.ts`, и второй проход по ним запрещён.
 */
export function sentryBeforeSend(event: ErrorEvent): ErrorEvent {
  if (typeof event?.message === 'string') {
    event.message = redactEventText(event.message);
  }

  const values = event?.exception?.values;
  if (Array.isArray(values)) {
    for (const item of values) {
      if (item && typeof item.value === 'string') {
        item.value = redactEventText(item.value);
      }
    }
  }

  const request = event?.request;
  if (request) {
    const allow = allowListForUrl(request.url);

    if (typeof request.url === 'string') {
      request.url = redactUrl(request.url, allow);
    }
    // Тело приходит и разобранным объектом, и сырой строкой: у строки имени
    // ключа нет вовсе, и закрыть её может только разбор по значению.
    if (typeof request.data === 'string') {
      request.data = redactFreeText(request.data);
    } else if (request.data !== undefined) {
      request.data = redactKeys(request.data, allow) as Record<string, unknown>;
    }
    if (request.query_string !== undefined) {
      request.query_string = redactKeys(request.query_string, allow) as typeof request.query_string;
    }
    if (request.cookies !== undefined) {
      request.cookies = redactKeys(request.cookies, allow) as typeof request.cookies;
    }
    // 🔴 Заголовки идут **без** белого списка — так же, как в фильтре: у них
    // своя маска, а под белым списком `authorization` и `user-agent` стали бы
    // `[Filtered]` вместе со всем остальным, и разбирать отказ было бы нечем.
    if (request.headers !== undefined) {
      request.headers = redactKeys(request.headers) as typeof request.headers;
    }
  }

  return event;
}
