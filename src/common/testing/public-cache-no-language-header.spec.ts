import { readFileSync } from 'fs';
import * as ts from 'typescript';
import { VISITOR_IP_HEADER } from '../net/client-ip';
import {
  SRC_ROOT,
  guardsInclude,
  listControllerFiles,
  relativeToSrc,
} from './controller-decorators';
import { PUBLIC_CACHE_HANDLERS } from './public-cache-handlers';

/**
 * Сторож «публично кэшируемый ответ не зависит от заголовка запроса»
 * (`LEGACY-104`, остаток `LEGACY-107`).
 *
 * Ответ с `Cache-Control: public` хранится общим кэшем по ключу, и ключ этот —
 * URL. Пока обработчик читает `Accept-Language`, два клиента по одному адресу
 * получают разные тела, а кэш раздаёт всем то, которое пришло первым: 300
 * секунд плюс час `stale-while-revalidate`. Для `/seo/resolve` это `title`,
 * `description`, `canonical` и OG-разметка, то есть вся видимая поисковику
 * разметка страницы в чужом языке.
 *
 * 🔴 **Почему тест, а не `Vary`.** До 13.09.2026 рубежом был заголовок
 * `Vary: Accept-Language` на публичной ветке `PublicCacheInterceptor`. Он
 * не работал: Cloudflare расщепляет ключ кэша только по `Accept-Encoding`,
 * прочие поля `Vary` игнорирует без custom cache key (Enterprise, тарифом
 * не покрыт). То есть рубеж выглядел стоящим и не стоял — худший вид защиты.
 * Решением арбитра 13.09.2026 (вариант A) заголовок снят, а требование
 * перенесено сюда, где оно умеет покраснеть.
 *
 * ⚠️ **Рубеж у́же снятого `Vary`, и это надо знать.** `Vary` покрывал всю
 * публичную ветку интерцептора; сторож смотрит только обработчики из
 * `PUBLIC_CACHE_HANDLERS` и только их контроллеры — не сервисы, которые они
 * зовут. Обмен сознательный: `Vary` покрывал шире, но на целевом CDN
 * не действовал вовсе.
 *
 * ⚠️ Разбор через TypeScript compiler API, а не регуляркой. Текстовый сторож
 * того же назначения в этом репозитории уже пробивали мутациями: комментарий
 * `// @ApiProperty()` сходил за настоящий декоратор, а перенос строки прятал
 * объявление (`LEGACY-190`, решение арбитра 04.09.2026).
 *
 * ⚠️ Список обработчиков берётся из `public-cache-handlers.ts`, общего
 * с `cache-headers-wiring.spec.ts`. Вторая рукописная копия разошлась бы
 * с первой молча, и сторожа отвечали бы про разные наборы маршрутов
 * (`LEGACY-290`).
 *
 * ⚠️ С 06.10.2026 (`T105`, решение арбитра) сторож смотрит не только заголовки,
 * но и **того, кто спрашивает**: параметр-декораторы из `USER_DECORATORS`
 * и гварды из `CALLER_GUARDS` в `@UseGuards` метода или класса (списки
 * и границы — у самих констант). Это условие переоткрытия принятого остатка `LEGACY-108`: без этой проверки
 * обработчик под публичным кэшем мог начать читать пользователя, и ни один
 * сторож этого бы не заметил (`B13` смотрит только добавленную строку
 * интерцептора).
 */

/** Ниже этого числа разбор сломан, а не репозиторий поредел. */
const MIN_CONTROLLERS = 40;

/**
 * Заголовки, чтение которых на публично кэшируемом обработчике запрещено.
 *
 * Список не сводится к `accept-language`: любой заголовок запроса, попавший
 * в тело, даёт ровно тот же дефект — ответ, разный у двух клиентов по одному
 * URL.
 *
 * - `authorization` и `cookie` — обработчик из списка публичен по определению,
 *   и персональный ответ в нём означал бы утечку класса `LEGACY-088`;
 * - `cf-ipcountry` и `x-geo-country` — **живые** источники страны
 *   (`geo-ip-country.service.ts:48,52`). Гео-зависимый ответ под публичным
 *   кэшем раздаёт содержимое разрешённой страны заблокированной и наоборот —
 *   это остаток `LEGACY-174`.
 *
 * ⚠️ `x-country-code` в списке **нет намеренно**: ветку этого заголовка
 * вырезали 12.09.2026 вместе с флагом (`LEGACY-208`), и `resolveCountry`
 * её не читает. Мёртвая запись в списке запрета — не лишняя строгость,
 * а ложное чувство покрытия: она выглядит как «гео закрыто», пока живые
 * два заголовка проходят мимо.
 */
const FORBIDDEN_HEADERS = [
  'accept-language',
  'authorization',
  'cookie',
  'cf-ipcountry',
  'x-geo-country',
  // Адрес клиента — тот же вход, что `@Ip()` ниже: страна по IP (`LEGACY-174`).
  // `src/common/net/client-ip.ts` читает `cf-connecting-ip` и `x-visitor-ip`
  // (`VISITOR_IP_HEADER`); `x-forwarded-for` — то, из чего Express собирает
  // `req.ip` при `trust proxy`.
  'cf-connecting-ip',
  'x-forwarded-for',
  VISITOR_IP_HEADER,
];

/**
 * Декораторы-читатели заголовков: из какого модуля и под каким экспортируемым
 * именем приходят.
 *
 * 🔴 Имя сверяется **не с текстом в коде, а с тем, что импортировано**:
 * `import { Headers as Hdrs } from '@nestjs/common'` и `@Hdrs('accept-language')`
 * обошли бы сравнение с литералом `Headers`. Это тот же класс молчаливого
 * обхода, о котором предупреждает `LEGACY-190`, только через переименование.
 */
const HEADER_DECORATORS: ReadonlyArray<{ module: string; name: string }> = [
  { module: '@nestjs/common', name: 'Headers' },
  // 🔴 `@Language()` — штатный способ прочитать тот же `Accept-Language`
  // в обход `@Headers`. `LanguageResolverGuard` (`language-resolver.guard.ts:28`)
  // читает заголовок и кладёт язык в `req.language`, а декоратор достаёт его
  // оттуда (`language.decorator.ts:8`). `PublicController` несёт этот гвард
  // на классе, так что обработчику хватило бы одного параметра
  // `@Language() lang`, чтобы вернуть дефект `LEGACY-104` целиком.
  { module: 'language.decorator', name: 'Language' },
];

/**
 * Читатели пользователя: параметр-декораторы, отдающие запрос целиком или того,
 * кто спрашивает, и гварды, кладущие пользователя в запрос.
 *
 * `@Req()`/`@Request()` запрещены целиком, а не по `req.user`: объект запроса
 * несёт и пользователя, и все заголовки, и разбирать, что из него прочитали,
 * значит снова гоняться за формами доступа. Модуль `@nestjs/common` сверяется,
 * потому что тип `Request` из `express` — не декоратор. `CurrentUser` в проекте
 * на 06.10.2026 нет (`author.controller.ts`, докблок), поэтому он сверяется
 * по имени из любого модуля: появится — уже под запретом. `@Ip()` и `@Session()`
 * — тот же дефект другим входом: страна по адресу клиента (`LEGACY-174`)
 * и сессия того, кто спрашивает. `@Res()`/`@Response()` — запрос через
 * `res.req`, `@Next()` — ответ собирает цепочка Express, а не обработчик.
 *
 * ⚠️ Чего сторож не видит: `@Inject(REQUEST)` в конструкторе контроллера
 * или сервиса, гвард из составного декоратора (`applyDecorators`), из
 * базового класса или глобальный `APP_GUARD`. На 06.10.2026 первых трёх форм
 * в `src` нет; глобальных гвардов два (`app.module.ts`): `GlobalRateLimitGuard`
 * читает `authorization` только для корзины лимита, `LanguageResolverGuard`
 * кладёт язык в `req.language` — тело ответа меняет лишь второй, и его чтение
 * в обработчике ловит `bodyOffences`/`@Language()`.
 */
const WHOLE_REQUEST = 'запрос целиком, с пользователем';
const CALLER_DATA = 'данные того, кто спрашивает';

const USER_DECORATORS: ReadonlyArray<{ module: string; name: string; reason: string }> = [
  { module: '@nestjs/common', name: 'Req', reason: WHOLE_REQUEST },
  { module: '@nestjs/common', name: 'Request', reason: WHOLE_REQUEST },
  // `@Res()` отдаёт ответ, а через `res.req` — тот же запрос, что `@Req()`.
  { module: '@nestjs/common', name: 'Res', reason: `ответ, а через res.req ${WHOLE_REQUEST}` },
  { module: '@nestjs/common', name: 'Response', reason: `ответ, а через res.req ${WHOLE_REQUEST}` },
  {
    module: '@nestjs/common',
    name: 'Next',
    reason: 'цепочка Express — ответ собирает не обработчик',
  },
  { module: '@nestjs/common', name: 'Ip', reason: CALLER_DATA },
  { module: '@nestjs/common', name: 'Session', reason: CALLER_DATA },
  { module: '', name: 'CurrentUser', reason: CALLER_DATA },
];

const USER_DECORATOR_REASON = new Map(USER_DECORATORS.map(({ name, reason }) => [name, reason]));

/**
 * Гварды, которые читают того, кто спрашивает, или кладут его в запрос.
 * Ответ под таким гвардом зависит от токена, а общий кэш раздаёт его всем —
 * в том числе тем, кого гвард не пустил бы (`LEGACY-088`).
 *
 * `MetricsAccessGuard` — наследник `AuthGuard('jwt')`, `RolesGuard` читает
 * `req.user`, `RightsAgentTokenGuard` кладёт в запрос токен агента.
 *
 * Сверяются тем же `guardsInclude` из `controller-decorators.ts`, что
 * и в `swagger-bearer-auth.spec.ts` (`LEGACY-290`), — по границам слова,
 * поэтому ловятся `new JwtAuthGuard()` и `AuthGuard('jwt')`, а `JwtAuthGuard`
 * с `AuthGuard` не путается. Но подаётся ему **каждый** `@UseGuards` узла
 * отдельно и только его аргументы: Nest складывает гварды из всех
 * вхождений, а `guardsInclude` смотрит первое, и текст соседних декораторов
 * (`description` у `@ApiOperation`) в сверку не попадает.
 *
 * ⚠️ Чего сторож не видит: псевдоним импорта самого гварда
 * (`import { JwtAuthGuard as G }`) — граница `guardsInclude`;
 * `swagger-bearer-auth.spec.ts` слеп там же.
 */
const CALLER_GUARDS = [
  'JwtAuthGuard',
  'OptionalJwtAuthGuard',
  'MetricsAccessGuard',
  'AuthGuard',
  'RolesGuard',
  'RightsAgentTokenGuard',
];

/** `UseGuards` из `@nestjs/common` — с псевдонимом и пространством имён. */
const USE_GUARDS: ReadonlyArray<{ module: string; name: string }> = [
  { module: '@nestjs/common', name: 'UseGuards' },
];

/**
 * Совпадает ли путь импорта с модулем кандидата: пакет целиком или его
 * подпуть (`@nestjs/common/decorators/...` — так пишет автоимпорт IDE),
 * либо последний сегмент относительного пути. Подстрокой нельзя —
 * `@nestjs/common` входит в `@nestjs/common-x` (`L-008`). Пустой модуль — любой.
 */
const fromModule = (from: string, module: string): boolean =>
  module === '' || from === module || from.startsWith(`${module}/`) || from.endsWith(`/${module}`);

/**
 * Локальные имена импортов из списка **в этом файле**, с учётом псевдонимов
 * и импорта пространством имён (`import * as common` → `common.Req`):
 * ключ — имя в коде, значение — экспортируемое имя.
 */
const importedNames = (
  source: ts.SourceFile,
  wanted: ReadonlyArray<{ module: string; name: string }>,
): Map<string, string> => {
  const names = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const from = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      for (const candidate of wanted) {
        if (fromModule(from, candidate.module)) {
          names.set(`${bindings.name.text}.${candidate.name}`, candidate.name);
        }
      }
      continue;
    }
    for (const element of bindings.elements) {
      const exported = (element.propertyName ?? element.name).text;
      const match = wanted.find(
        (candidate) => candidate.name === exported && fromModule(from, candidate.module),
      );
      if (match) names.set(element.name.text, match.name);
    }
  }
  return names;
};

const decoratorCalls = (node: ts.Node): ts.CallExpression[] =>
  (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [])
    .map((decorator) => decorator.expression)
    .filter((expression): expression is ts.CallExpression => ts.isCallExpression(expression));

/**
 * Чем провинился параметр, или `null` — если ничем.
 *
 * 🔴 `@Headers()` без аргумента отдаёт **все** заголовки разом, включая
 * запрещённые, поэтому нарушением считается сам по себе. Так же трактуется
 * имя, собранное выражением: разобрать его нельзя, а молчать на нём значит
 * пропустить `@Headers(HEADER.ACCEPT_LANGUAGE)`.
 */
const parameterOffence = (
  parameter: ts.ParameterDeclaration,
  forbidden: Map<string, string>,
): string | null => {
  for (const call of decoratorCalls(parameter)) {
    const local = call.expression.getText();
    const kind = forbidden.get(local);
    if (!kind) continue;

    if (kind === 'Language') {
      return `@${local}() — язык из Accept-Language через LanguageResolverGuard`;
    }

    const [first] = call.arguments;
    if (first === undefined) return `@${local}() без имени — читает все заголовки разом`;
    if (!ts.isStringLiteralLike(first)) {
      return `@${local}(<выражение>) — имя заголовка не разобрать`;
    }
    const header = first.text.toLowerCase();
    if (FORBIDDEN_HEADERS.includes(header)) return `@${local}('${header}')`;
  }
  return null;
};

/**
 * Чтение заголовков в теле метода мимо декоратора.
 *
 * Формы три, и вторая — та, ради которой пришлось смотреть вызовы, а не
 * только доступ к свойству: `req.header('x')` и `req.get('x')` — методы
 * Express, то есть `CallExpression`, и разбор по `headers[...]` их не видит
 * вовсе. Третья — `req.language`, который `LanguageResolverGuard` выставляет
 * из того же заголовка.
 */
const bodyOffences = (method: ts.MethodDeclaration): string[] => {
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const called = node.expression.name.text;
      const [first] = node.arguments;
      if ((called === 'header' || called === 'get') && first && ts.isStringLiteralLike(first)) {
        const key = first.text.toLowerCase();
        if (FORBIDDEN_HEADERS.includes(key)) {
          found.push(`${node.expression.getText()}('${key}') в теле метода`);
        }
      }
    }

    if (ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) {
      const target = ts.isElementAccessExpression(node) ? node.argumentExpression : node.name;
      const key = ts.isStringLiteralLike(target)
        ? target.text.toLowerCase()
        : target.getText().toLowerCase();
      if (
        FORBIDDEN_HEADERS.includes(key) &&
        node.expression.getText().toLowerCase().includes('headers')
      ) {
        found.push(`headers['${key}'] в теле метода`);
      }
    }

    if (ts.isPropertyAccessExpression(node) && node.name.text === 'language') {
      const owner = node.expression.getText().toLowerCase();
      if (owner === 'req' || owner === 'request') {
        found.push('req.language — язык из Accept-Language через LanguageResolverGuard');
      }
    }

    node.forEachChild(visit);
  };

  if (method.body) method.body.forEachChild(visit);
  return found;
};

/** Параметр, отдающий обработчику пользователя или запрос целиком, или `null`. */
const userParameterOffence = (
  parameter: ts.ParameterDeclaration,
  userDecorators: Map<string, string>,
): string | null => {
  for (const call of decoratorCalls(parameter)) {
    const local = call.expression.getText();
    const kind = userDecorators.get(local);
    if (kind) return `@${local}() — ${USER_DECORATOR_REASON.get(kind)}`;
  }
  return null;
};

/** Гварды того, кто спрашивает, во всех `@UseGuards` узла (метода или класса). */
const guardOffences = (node: ts.Node, where: string, useGuards: Map<string, string>): string[] =>
  decoratorCalls(node)
    .filter((call) => useGuards.has(call.expression.getText()))
    .map((call) => `@UseGuards(${call.arguments.map((argument) => argument.getText()).join(', ')})`)
    .flatMap((text) => CALLER_GUARDS.filter((guard) => guardsInclude(text, guard)))
    .map((guard) => `@UseGuards(${guard}) на ${where} — гвард того, кто спрашивает`);

type Offender = { id: string; reason: string };

/**
 * Нарушения в одном файле — у методов, которые `isHandler` признал публично
 * кэшируемыми. Отделено от обхода дерева, чтобы детектор прогонялся
 * и на заведомо плохом входе (ниже), а не только на дереве, где нарушений
 * нет (`L-017`). Гвард класса считается один раз на класс, а не на каждый
 * его обработчик.
 */
const offencesIn = (
  source: ts.SourceFile,
  where: string,
  isHandler: (id: string) => boolean,
): { offenders: Offender[]; seen: string[] } => {
  const offenders: Offender[] = [];
  const seen: string[] = [];
  const forbidden = importedNames(source, HEADER_DECORATORS);
  const userDecorators = importedNames(source, USER_DECORATORS);
  const useGuards = importedNames(source, USE_GUARDS);

  source.forEachChild((node) => {
    if (!ts.isClassDeclaration(node)) return;
    let handlers = 0;
    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member) || !member.name) continue;
      const id = `${where} → ${member.name.getText()}`;
      if (!isHandler(id)) continue;
      seen.push(id);
      handlers += 1;

      for (const parameter of member.parameters) {
        const reason = parameterOffence(parameter, forbidden);
        if (reason) offenders.push({ id, reason });
        const userReason = userParameterOffence(parameter, userDecorators);
        if (userReason) offenders.push({ id, reason: userReason });
      }
      for (const reason of [
        ...bodyOffences(member),
        ...guardOffences(member, 'методе', useGuards),
      ]) {
        offenders.push({ id, reason });
      }
    }
    if (handlers === 0) return;
    const id = `${where} → класс ${node.name?.getText() ?? '<без имени>'}`;
    for (const reason of guardOffences(node, 'классе', useGuards)) offenders.push({ id, reason });
  });

  return { offenders, seen };
};

const collect = (): { offenders: Offender[]; controllers: number; seen: string[] } => {
  const offenders: Offender[] = [];
  const seen: string[] = [];
  const files = listControllerFiles(SRC_ROOT);

  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const found = offencesIn(source, relativeToSrc(file), (id) =>
      PUBLIC_CACHE_HANDLERS.includes(id),
    );
    offenders.push(...found.offenders);
    seen.push(...found.seen);
  }

  return { offenders, controllers: files.length, seen };
};

/** Причины нарушений в синтетическом контроллере; обработчиком считается любой метод. */
const reasonsFor = (code: string): string[] =>
  offencesIn(
    ts.createSourceFile('fixture.controller.ts', code, ts.ScriptTarget.Latest, true),
    'fixture',
    () => true,
  ).offenders.map((offender) => offender.reason);

describe('публично кэшируемый ответ не зависит от заголовка запроса и от пользователя', () => {
  const { offenders, controllers, seen } = collect();

  it(`разбор находит не меньше ${MIN_CONTROLLERS} контроллеров`, () => {
    expect(controllers).toBeGreaterThanOrEqual(MIN_CONTROLLERS);
  });

  /**
   * 🔴 Без этой проверки сторож не умеет покраснеть вовсе: опечатка в имени
   * файла или метода внутри `PUBLIC_CACHE_HANDLERS` оставила бы `seen` пустым,
   * `offenders` — тоже пустым, и проверка ниже прошла бы, не посмотрев ни
   * на один обработчик. Сверка идёт с тем же списком, что и у
   * `cache-headers-wiring.spec.ts`, поэтому разойтись они не могут.
   */
  it('доходит до каждого обработчика из списка публичного кэша', () => {
    expect([...seen].sort()).toEqual([...PUBLIC_CACHE_HANDLERS].sort());
  });

  it('ни один из них не читает Accept-Language, прочие заголовки запроса и пользователя', () => {
    expect(offenders.map((offender) => `${offender.id}: ${offender.reason}`)).toEqual([]);
  });
});

/**
 * 🔴 Проверка выше на дереве, где нарушений нет, зелёная и у сломанного
 * детектора: опечатка в имени модуля даёт пустую карту импортов, и сторож
 * молча ничего не ловит (`L-017`, `L-033`). Поэтому каждый вид нарушения
 * прогоняется на синтетическом контроллере — и чистый вход рядом.
 */
describe('детектор краснеет на каждом виде нарушения', () => {
  const COMMON =
    "import { Controller, Get, Headers, Ip, Query, Req, Next, Request, Res, Response, Session, UseGuards } from '@nestjs/common';";
  const handler = (decorators: string, params = ''): string =>
    `${COMMON}\n@Controller() class C { @Get() ${decorators} handler(${params}) {} }`;

  it.each([
    [
      '@Req() под псевдонимом',
      "import { Req as R } from '@nestjs/common';\n@Controller() class C { @Get() handler(@R() r: unknown) {} }",
      ['@R() — запрос целиком, с пользователем'],
    ],
    [
      '@Request()',
      handler('', '@Request() r: unknown'),
      ['@Request() — запрос целиком, с пользователем'],
    ],
    [
      '@common.Req() при импорте пространством имён',
      "import * as common from '@nestjs/common';\n@common.Controller() class C { @common.Get() handler(@common.Req() r: unknown) {} }",
      ['@common.Req() — запрос целиком, с пользователем'],
    ],
    [
      '@CurrentUser()',
      "import { CurrentUser } from '../auth/current-user.decorator';\n@Controller() class C { @Get() handler(@CurrentUser() u: unknown) {} }",
      ['@CurrentUser() — данные того, кто спрашивает'],
    ],
    ['@Ip()', handler('', '@Ip() ip: string'), ['@Ip() — данные того, кто спрашивает']],
    [
      'OptionalJwtAuthGuard на методе',
      handler('@UseGuards(OptionalJwtAuthGuard)'),
      ['@UseGuards(OptionalJwtAuthGuard) на методе — гвард того, кто спрашивает'],
    ],
    [
      'new JwtAuthGuard() на методе',
      handler('@UseGuards(new JwtAuthGuard())'),
      ['@UseGuards(JwtAuthGuard) на методе — гвард того, кто спрашивает'],
    ],
    [
      "AuthGuard('jwt') на методе",
      handler("@UseGuards(AuthGuard('jwt'))"),
      ['@UseGuards(AuthGuard) на методе — гвард того, кто спрашивает'],
    ],
    [
      'MetricsAccessGuard на методе',
      handler('@UseGuards(MetricsAccessGuard)'),
      ['@UseGuards(MetricsAccessGuard) на методе — гвард того, кто спрашивает'],
    ],
    [
      'JwtAuthGuard на классе — один раз, а не на каждый обработчик',
      `${COMMON}\n@UseGuards(JwtAuthGuard) @Controller() class C { @Get() a() {} @Get() b() {} }`,
      ['@UseGuards(JwtAuthGuard) на классе — гвард того, кто спрашивает'],
    ],
    [
      '@Headers() без имени',
      handler('', '@Headers() h: unknown'),
      ['@Headers() без имени — читает все заголовки разом'],
    ],
    [
      '@Session()',
      handler('', '@Session() session: unknown'),
      ['@Session() — данные того, кто спрашивает'],
    ],
    [
      '@u.CurrentUser() при импорте пространством имён',
      "import * as u from '../auth/current-user.decorator';\n@Controller() class C { @Get() handler(@u.CurrentUser() x: unknown) {} }",
      ['@u.CurrentUser() — данные того, кто спрашивает'],
    ],
    [
      '@Req() из подпути @nestjs/common',
      "import { Req } from '@nestjs/common/decorators/http/route-params.decorator';\n@Controller() class C { @Get() handler(@Req() r: unknown) {} }",
      ['@Req() — запрос целиком, с пользователем'],
    ],
    [
      "@Headers('accept-language') под псевдонимом",
      "import { Headers as H } from '@nestjs/common';\n@Controller() class C { @Get() handler(@H('accept-language') l: string) {} }",
      ["@H('accept-language')"],
    ],
    [
      "@n.Headers('cookie') при импорте пространством имён",
      "import * as n from '@nestjs/common';\n@Controller() class C { @Get() handler(@n.Headers('cookie') c: string) {} }",
      ["@n.Headers('cookie')"],
    ],
    [
      '@Res({ passthrough: true })',
      handler('', '@Res({ passthrough: true }) res: unknown'),
      ['@Res() — ответ, а через res.req запрос целиком, с пользователем'],
    ],
    [
      '@Response()',
      handler('', '@Response() res: unknown'),
      ['@Response() — ответ, а через res.req запрос целиком, с пользователем'],
    ],
    [
      '@Next()',
      handler('', '@Next() next: unknown'),
      ['@Next() — цепочка Express — ответ собирает не обработчик'],
    ],
    [
      'JwtAuthGuard на методе',
      handler('@UseGuards(JwtAuthGuard)'),
      ['@UseGuards(JwtAuthGuard) на методе — гвард того, кто спрашивает'],
    ],
    [
      '@common.UseGuards при импорте пространством имён',
      "import * as common from '@nestjs/common';\n@common.Controller() class C { @common.Get() @common.UseGuards(JwtAuthGuard) handler() {} }",
      ['@UseGuards(JwtAuthGuard) на методе — гвард того, кто спрашивает'],
    ],
    [
      "@Headers('x-visitor-ip')",
      handler('', "@Headers('x-visitor-ip') ip: string"),
      ["@Headers('x-visitor-ip')"],
    ],
    [
      "req.headers['x-forwarded-for'] в теле метода",
      handler('', 'q: unknown').replace('{} }', "{ return req.headers['x-forwarded-for']; } }"),
      ["headers['x-forwarded-for'] в теле метода"],
    ],
    [
      "@Headers('cf-connecting-ip')",
      handler('', "@Headers('cf-connecting-ip') ip: string"),
      ["@Headers('cf-connecting-ip')"],
    ],
    [
      '@Language() по относительному пути',
      "import { Language } from '../../common/decorators/language.decorator';\n@Controller() class C { @Get() handler(@Language() l: string) {} }",
      ['@Language() — язык из Accept-Language через LanguageResolverGuard'],
    ],
    [
      'req.language в теле метода',
      handler('', 'q: unknown').replace('{} }', '{ return req.language; } }'),
      ['req.language — язык из Accept-Language через LanguageResolverGuard'],
    ],
    [
      "req.header('cookie') в теле метода",
      handler('', 'q: unknown').replace('{} }', "{ return req.header('cookie'); } }"),
      ["req.header('cookie') в теле метода"],
    ],
    [
      'второй @UseGuards на том же методе',
      handler('@UseGuards(LanguageResolverGuard) @UseGuards(OptionalJwtAuthGuard)'),
      ['@UseGuards(OptionalJwtAuthGuard) на методе — гвард того, кто спрашивает'],
    ],
    [
      'UseGuards под псевдонимом',
      "import { Controller, Get, UseGuards as G } from '@nestjs/common';\n@Controller() class C { @Get() @G(JwtAuthGuard) handler() {} }",
      ['@UseGuards(JwtAuthGuard) на методе — гвард того, кто спрашивает'],
    ],
    [
      'RolesGuard на методе',
      handler('@UseGuards(RolesGuard)'),
      ['@UseGuards(RolesGuard) на методе — гвард того, кто спрашивает'],
    ],
    [
      'RightsAgentTokenGuard на методе',
      handler('@UseGuards(RightsAgentTokenGuard)'),
      ['@UseGuards(RightsAgentTokenGuard) на методе — гвард того, кто спрашивает'],
    ],
  ])('%s', (_name, code, reasons) => {
    expect(reasonsFor(code)).toEqual(reasons);
  });

  it('текст соседнего декоратора не подменяет @UseGuards', () => {
    const code = handler(
      "@ApiOperation({ description: 'no @UseGuards() needed' }) @UseGuards(JwtAuthGuard)",
    );
    expect(reasonsFor(code)).toEqual([
      '@UseGuards(JwtAuthGuard) на методе — гвард того, кто спрашивает',
    ]);
  });

  it('чужой пакет с похожим именем — не @nestjs/common (L-008)', () => {
    const code =
      "import { Req, UseGuards } from '@nestjs/common-x';\n@Controller() class C { @Get() @UseGuards(LanguageResolverGuard) handler(@Req() r: unknown) {} }";
    expect(reasonsFor(code)).toEqual([]);
  });

  it('чистый обработчик проходит: query, гвард языка, тип Request из express', () => {
    const code = [
      COMMON,
      "import type { Request as ExpressRequest } from 'express';",
      '@UseGuards(LanguageResolverGuard) @Controller() class C {',
      '  @Get() handler(@Query() q: unknown, r?: ExpressRequest) {}',
      '}',
    ].join('\n');
    expect(reasonsFor(code)).toEqual([]);
  });
});
