import { readFileSync } from 'fs';
import * as ts from 'typescript';
import { VISITOR_IP_HEADER } from '../net/client-ip';
import {
  NEST_COMMON,
  NEST_SWAGGER,
  SRC_ROOT,
  controllersIn,
  decoratorsOf,
  isFromModule,
  guardsOf,
  importsOf,
  interceptorsOf,
  isFrom,
  listControllerFiles,
  listFiles,
  parseControllerFile,
  parseSource,
  propertyKey,
  referenceOf,
  referencesOf,
  stringValue,
  unwrap,
  verbOf,
} from './controller-decorators';
import type { ControllerInfo, DecoratorUse, HandlerInfo, Reference } from './controller-decorators';
import { PUBLIC_CACHE_HANDLERS } from './public-cache-handlers';

/**
 * Сторож «публично кэшируемый ответ не зависит от того, кто спрашивает»
 * (`LEGACY-104`, остаток `LEGACY-107`, `LEGACY-108`).
 *
 * Ответ с `Cache-Control: public` хранится общим кэшем по ключу, и ключ этот —
 * URL. Пока обработчик читает `Accept-Language`, два клиента по одному адресу
 * получают разные тела, а кэш раздаёт всем то, которое пришло первым: 300
 * секунд плюс час `stale-while-revalidate`. Для `/seo/resolve` это `title`,
 * `description`, `canonical` и OG-разметка, то есть вся видимая поисковику
 * разметка страницы в чужом языке. То же и с пользователем, и со страной
 * по адресу клиента: персональный или гео-зависимый ответ под публичным
 * кэшем раздаётся всем (`LEGACY-088`, `LEGACY-174`).
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
 * ⚠️ Разбор — общий, по TypeScript AST, из `controller-decorators.ts`
 * (`LEGACY-290`). Текстовый сторож того же назначения в этом репозитории уже
 * пробивали мутациями: комментарий `// @ApiProperty()` сходил за настоящий
 * декоратор, а перенос строки прятал объявление (`LEGACY-190`, решение арбитра
 * 04.09.2026). Имена сверяются по тому, что импортировано: псевдоним, пространство
 * имён, подпуть пакета и импорт с расширением — те же декораторы и те же гварды.
 *
 * ⚠️ Список обработчиков берётся из `public-cache-handlers.ts`, общего
 * с `cache-headers-wiring.spec.ts`. Вторая рукописная копия разошлась бы
 * с первой молча, и сторожа отвечали бы про разные наборы маршрутов
 * (`LEGACY-290`).
 *
 * ⚠️ **Список допустимого, а не список запрещённого** (`T108`, 06.10.2026).
 * С `T105` сторож смотрел «того, кто спрашивает», но по перечню известных
 * читателей (`@Req()`, `JwtAuthGuard`, …): новый читатель, которого в перечне
 * нет, проходил молча. Теперь на публично кэшируемом обработчике и его классе
 * допустимы только перечисленные параметр-декораторы (`ALLOWED_PARAM_DECORATORS`),
 * гварды (`ALLOWED_GUARDS`), интерцепторы (`ALLOWED_INTERCEPTORS`) и декораторы
 * (`isAllowedDecorator`); всё остальное — нарушение, даже если читателем не названо.
 * Старый перечень остаётся как каталог причин: он объясняет, **почему** отказ.
 * Расширить список — осознанный шаг в этом файле, а не побочный эффект правки
 * контроллера.
 *
 * ⚠️ Гвард, который сторож по тексту обработчика не разберёт, он и не должен
 * пропускать: составной декоратор (`applyDecorators`), базовый класс,
 * `@Inject(REQUEST)` и запрос-скоуп контроллера — нарушения сами по себе;
 * глобальные гварды (`APP_GUARD`, `useGlobalGuards`) сверяются с явным списком
 * `GLOBAL_GUARDS`. Остаётся граница: запрос, который читает **сервис**, зовущий
 * обработчик (`@Inject(REQUEST)` внутри сервиса), сторож не видит.
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
 * Читатели пользователя: параметр-декораторы, отдающие запрос целиком или того,
 * кто спрашивает. Это **каталог причин**: допустимость решает
 * `ALLOWED_PARAM_DECORATORS`, а здесь записано, чем именно провинился
 * известный читатель.
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
 */
const WHOLE_REQUEST = 'запрос целиком, с пользователем';
const CALLER_DATA = 'данные того, кто спрашивает';

const USER_DECORATORS: ReadonlyArray<{ module: string; name: string; reason: string }> = [
  { module: NEST_COMMON, name: 'Req', reason: WHOLE_REQUEST },
  { module: NEST_COMMON, name: 'Request', reason: WHOLE_REQUEST },
  // `@Res()` отдаёт ответ, а через `res.req` — тот же запрос, что `@Req()`.
  { module: NEST_COMMON, name: 'Res', reason: `ответ, а через res.req ${WHOLE_REQUEST}` },
  { module: NEST_COMMON, name: 'Response', reason: `ответ, а через res.req ${WHOLE_REQUEST}` },
  {
    module: NEST_COMMON,
    name: 'Next',
    reason: 'цепочка Express — ответ собирает не обработчик',
  },
  { module: NEST_COMMON, name: 'Ip', reason: CALLER_DATA },
  { module: NEST_COMMON, name: 'Session', reason: CALLER_DATA },
  { module: '', name: 'CurrentUser', reason: CALLER_DATA },
];

/**
 * Допустимые параметр-декораторы публично кэшируемого обработчика: значения
 * из адреса и query. `@Headers('<имя>')` допустим только с именем из `ALLOWED_HEADERS`.
 * Всё прочее — нарушение, даже если в `USER_DECORATORS` его нет: новый способ
 * достать запрос не должен проходить, пока его не назвали.
 */
const ALLOWED_PARAM_DECORATORS = ['Param', 'Query'];

/**
 * Заголовки запроса, которые публично кэшируемому обработчику читать можно. Пусто
 * намеренно: любой заголовок, попавший в тело, даёт ответ, разный у двух клиентов
 * по одному URL (`x-real-ip`, `user-agent`, `true-client-ip` — тот же дефект, что
 * и `FORBIDDEN_HEADERS`). `FORBIDDEN_HEADERS` остаётся каталогом причин и списком
 * для разбора тела, где форма доступа не всегда однозначна.
 */
const ALLOWED_HEADERS: readonly string[] = [];

/**
 * Гварды, чьё присутствие на публично кэшируемом обработчике или его классе
 * не делает ответ зависимым от того, кто спрашивает. `LanguageResolverGuard`
 * кладёт язык в `req.language` из пути и заголовка; чтение этого языка
 * в обработчике ловит `bodyOffences` и `@Language()`.
 */
const ALLOWED_GUARDS: ReadonlyArray<{ name: string; module: string }> = [
  { name: 'LanguageResolverGuard', module: 'guards/language-resolver.guard' },
];

/** Интерцепторы допустимы те же: публичный кэш и больше ничего. */
const ALLOWED_INTERCEPTORS: ReadonlyArray<{ name: string; module: string }> = [
  { name: 'PublicCacheInterceptor', module: 'interceptors/public-cache.interceptor' },
];

/**
 * Допустим ли гвард или интерцептор: имя **и** модуль, откуда он импортирован (`L-008`).
 * Класс с тем же именем, объявленный в файле или пришедший из другого модуля, —
 * не он: свой `LanguageResolverGuard` из `../evil.guard` мог бы читать `req.user`.
 */
const isAllowedRef = (
  ref: Reference,
  allowed: ReadonlyArray<{ name: string; module: string }>,
): boolean =>
  ref.module !== '' && allowed.some((candidate) => isFrom(ref, candidate.name, candidate.module));

/**
 * Глобальные гварды приложения (`APP_GUARD`, `app.useGlobalGuards`): они действуют
 * и на публично кэшируемые обработчики, где бы ни были объявлены. Новый
 * глобальный гвард красит сторож, пока его не внесли сюда сознательно:
 * `GlobalRateLimitGuard` читает `authorization` только для корзины лимита,
 * `LanguageResolverGuard` кладёт язык в `req.language`.
 */
const GLOBAL_GUARDS = ['GlobalRateLimitGuard', 'LanguageResolverGuard'];

/**
 * Гварды, которые читают того, кто спрашивает, или кладут его в запрос.
 * Ответ под таким гвардом зависит от токена, а общий кэш раздаёт его всем —
 * в том числе тем, кого гвард не пустил бы (`LEGACY-088`). Каталог причин,
 * как и `USER_DECORATORS`: допустимость решает `ALLOWED_GUARDS`.
 *
 * `MetricsAccessGuard` — наследник `AuthGuard('jwt')`, `RolesGuard` читает
 * `req.user`, `RightsAgentTokenGuard` кладёт в запрос токен агента.
 */
const CALLER_GUARDS = [
  'JwtAuthGuard',
  'OptionalJwtAuthGuard',
  'MetricsAccessGuard',
  'AuthGuard',
  'RolesGuard',
  'RightsAgentTokenGuard',
];

/** Язык из заголовка `Accept-Language` через `LanguageResolverGuard`. */
const LANGUAGE_REASON = 'язык из Accept-Language через LanguageResolverGuard';

/**
 * Допустим ли декоратор на публично кэшируемом обработчике или его классе.
 * Гварды и интерцепторы проверяются по аргументам отдельно, здесь только
 * сам декоратор. 🔴 Неизвестный декоратор — нарушение: составной
 * `applyDecorators(...)` или самодельный `@Auth()` мог положить гвард, которого
 * в тексте обработчика не видно.
 *
 * ⚠️ Допустимое — только **импортированное** из своего модуля, как и в `isAllowedRef`:
 * объявленный в файле `const Get = applyDecorators(Get(), UseGuards(X))` или свой
 * `NoPublicCache` из чужого модуля — не они.
 */
const isAllowedDecorator = (use: DecoratorUse): boolean =>
  use.module !== '' &&
  (isFrom(use, 'Controller', NEST_COMMON) ||
    verbOf(use) !== undefined ||
    ['Header', 'HttpCode', 'UseGuards', 'UseInterceptors'].some((name) =>
      isFrom(use, name, NEST_COMMON),
    ) ||
    // Документация OpenAPI на исполнение запроса не влияет; ограничено импортом из
    // `@nestjs/swagger`, чтобы свой `ApiAuth()` не прошёл по имени.
    (use.name.startsWith('Api') && isFromModule(use.module, NEST_SWAGGER)) ||
    isFrom(use, 'NoPublicCache', 'decorators/no-public-cache.decorator'));

/**
 * Чем провинился параметр, или `null` — если ничем.
 *
 * 🔴 `@Headers()` без аргумента отдаёт **все** заголовки разом, включая
 * запрещённые, поэтому нарушением считается сам по себе. Так же трактуется
 * имя, собранное выражением: разобрать его нельзя, а молчать на нём значит
 * пропустить `@Headers(HEADER.ACCEPT_LANGUAGE)`.
 */
const parameterOffence = (use: DecoratorUse): string | null => {
  const local = use.text;

  if (isFrom(use, 'Language', 'language.decorator')) {
    return `@${local}() — ${LANGUAGE_REASON}`;
  }

  if (isFrom(use, 'Headers', NEST_COMMON)) {
    const [first] = use.args;
    if (first === undefined) return `@${local}() без имени — читает все заголовки разом`;
    const header = stringValue(first)?.toLowerCase();
    if (header === undefined) return `@${local}(<выражение>) — имя заголовка не разобрать`;
    if (FORBIDDEN_HEADERS.includes(header)) return `@${local}('${header}')`;
    return ALLOWED_HEADERS.includes(header)
      ? null
      : `@${local}('${header}') — заголовок вне списка допустимых`;
  }

  const known = USER_DECORATORS.find((candidate) => isFrom(use, candidate.name, candidate.module));
  if (known) return `@${local}() — ${known.reason}`;

  // Только импортированный из `@nestjs/common`: свой `const Query = createParamDecorator(...)`,
  // объявленный в файле, мог бы отдать заголовок запроса.
  if (
    use.module !== '' &&
    ALLOWED_PARAM_DECORATORS.some((name) => isFrom(use, name, NEST_COMMON))
  ) {
    return null;
  }
  return `@${local}() — декоратор параметра вне списка допустимых`;
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
        // `.header()` — только заголовок запроса, поэтому любое имя вне списка допустимого;
        // `.get()` есть и у `Map`, и у сервисов, поэтому он сверяется с каталогом запрета.
        const offends =
          called === 'header' ? !ALLOWED_HEADERS.includes(key) : FORBIDDEN_HEADERS.includes(key);
        if (offends) {
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
        !ALLOWED_HEADERS.includes(key) &&
        /\bheaders\b/.test(node.expression.getText().toLowerCase())
      ) {
        found.push(`headers['${key}'] в теле метода`);
      }
    }

    if (ts.isPropertyAccessExpression(node) && node.name.text === 'language') {
      const owner = node.expression.getText().toLowerCase();
      if (owner === 'req' || owner === 'request') {
        found.push(`req.language — ${LANGUAGE_REASON}`);
      }
    }

    node.forEachChild(visit);
  };

  if (method.body) method.body.forEachChild(visit);
  return found;
};

/**
 * Гварды, интерцепторы и сами декораторы узла (метода или класса), которых нет
 * в списках допустимого. Все вхождения `@UseGuards`/`@UseInterceptors`,
 * раскрытые до имён по импортам: псевдоним гварда — тот же гвард.
 */
const decoratorOffences = (uses: readonly DecoratorUse[], where: string): string[] => {
  const reasons: string[] = [];

  for (const ref of guardsOf(uses)) {
    if (isAllowedRef(ref, ALLOWED_GUARDS)) continue;
    const kind = !ref.name
      ? 'гвард не разобрать'
      : CALLER_GUARDS.includes(ref.name)
        ? 'гвард того, кто спрашивает'
        : 'гвард вне списка допустимых';
    reasons.push(`@UseGuards(${ref.name || ref.text}) на ${where} — ${kind}`);
  }

  for (const ref of interceptorsOf(uses)) {
    if (isAllowedRef(ref, ALLOWED_INTERCEPTORS)) continue;
    reasons.push(
      `@UseInterceptors(${ref.name || ref.text}) на ${where} — интерцептор вне списка допустимых`,
    );
  }

  for (const use of uses) {
    if (isAllowedDecorator(use)) continue;
    reasons.push(
      `@${use.text}() на ${where} — декоратор вне списка допустимых (составной декоратор мог положить гвард)`,
    );
  }

  return reasons;
};

/**
 * `@Inject(REQUEST)` в конструкторе или в свойстве контроллера и запрос-скоуп
 * самого контроллера: запрос того, кто спрашивает, попадает в контроллер
 * мимо параметров обработчика.
 */
const requestAccessOffences = (controller: ControllerInfo): string[] => {
  const found: string[] = [];
  const { imports } = controller;

  const inspect = (node: ts.Node, label: string): void => {
    for (const use of decoratorsOf(node, imports)) {
      if (!isFrom(use, 'Inject', NEST_COMMON)) continue;
      if (use.argRefs.some((ref) => ref.name === 'REQUEST')) {
        found.push(`@Inject(REQUEST) в ${label} — запрос того, кто спрашивает`);
      }
    }
  };

  for (const member of controller.node.members) {
    if (ts.isConstructorDeclaration(member)) {
      for (const parameter of member.parameters) inspect(parameter, 'конструкторе');
    } else if (ts.isPropertyDeclaration(member)) {
      inspect(member, 'свойстве класса');
    }
  }

  for (const use of controller.decorators) {
    if (!isFrom(use, 'Controller', NEST_COMMON)) continue;
    const [arg] = use.args;
    if (!arg || stringValue(arg) !== undefined) continue;
    // `{ ... } as const` и скобки — тот же литерал; константа с параметрами — не разобрать.
    const first = unwrap(arg);
    if (!ts.isObjectLiteralExpression(first)) {
      found.push(
        `@Controller(${arg.getText()}) — параметры контроллера не разобрать (мог быть scope)`,
      );
      continue;
    }
    // Ключ в кавычках — тот же ключ; `...options` мог принести `scope`, разобрать нельзя.
    if (
      first.properties.some(
        (property) => propertyKey(property) === 'scope' || ts.isSpreadAssignment(property),
      )
    ) {
      found.push(
        '@Controller({ scope }) — контроллер на запрос получает запрос того, кто спрашивает',
      );
    }
  }
  return found;
};

type Offender = { id: string; reason: string };

const handlerOffences = (handler: HandlerInfo, imports: ControllerInfo['imports']): string[] => {
  const reasons: string[] = [];
  for (const parameter of handler.node.parameters) {
    for (const use of decoratorsOf(parameter, imports)) {
      const reason = parameterOffence(use);
      if (reason) reasons.push(reason);
    }
  }
  return [
    ...reasons,
    ...bodyOffences(handler.node),
    ...decoratorOffences(handler.decorators, 'методе'),
  ];
};

/**
 * Нарушения в наборе контроллеров — у методов, которые `isHandler` признал
 * публично кэшируемыми. Отделено от обхода дерева, чтобы детектор прогонялся
 * и на заведомо плохом входе (ниже), а не только на дереве, где нарушений
 * нет (`L-017`). Свойства класса считаются один раз на класс, а не на каждый
 * его обработчик.
 */
const offencesIn = (
  controllers: readonly ControllerInfo[],
  isHandler: (id: string) => boolean,
): { offenders: Offender[]; seen: string[] } => {
  const offenders: Offender[] = [];
  const seen: string[] = [];

  for (const controller of controllers) {
    let handlers = 0;
    for (const handler of controller.handlers) {
      const id = `${controller.file} → ${handler.name}`;
      if (!isHandler(id)) continue;
      seen.push(id);
      handlers += 1;
      for (const reason of handlerOffences(handler, controller.imports))
        offenders.push({ id, reason });
    }
    if (handlers === 0) continue;

    const id = `${controller.file} → класс ${controller.className}`;
    const reasons = [
      ...decoratorOffences(controller.decorators, 'классе'),
      ...requestAccessOffences(controller),
      ...(controller.hasBaseClass
        ? ['класс наследует базовый — его декораторы и гварды не разобрать']
        : []),
    ];
    for (const reason of reasons) offenders.push({ id, reason });
  }

  return { offenders, seen };
};

/** Гварды, объявленные глобально: `{ provide: APP_GUARD, … }` и `useGlobalGuards(...)`. */
const globalGuardsIn = (source: ts.SourceFile): string[] => {
  const imports = importsOf(source);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const property = (name: string): ts.PropertyAssignment | undefined =>
        node.properties.find(
          (candidate): candidate is ts.PropertyAssignment =>
            ts.isPropertyAssignment(candidate) && propertyKey(candidate) === name,
        );
      const provide = property('provide');
      if (provide && referenceOf(provide.initializer, imports).name === 'APP_GUARD') {
        const used = property('useClass') ?? property('useExisting');
        found.push(
          used ? referenceOf(used.initializer, imports).name || '<выражение>' : '<фабрика>',
        );
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'useGlobalGuards'
    ) {
      for (const argument of node.arguments) {
        for (const ref of referencesOf(argument, imports)) found.push(ref.name || '<выражение>');
      }
    }
    node.forEachChild(visit);
  };

  visit(source);
  return found;
};

/** Глобальные гварды по всему `src` (без спек): имена, по одному на объявление. */
const globalGuards = (): string[] =>
  listFiles(SRC_ROOT, (path) => path.endsWith('.ts') && !path.endsWith('.spec.ts'))
    .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
    .filter(({ text }) => /APP_GUARD|useGlobalGuards/.test(text))
    .flatMap(({ file, text }) => globalGuardsIn(parseSource(text, file)));

const collect = (): { offenders: Offender[]; controllers: number; seen: string[] } => {
  const parsed = listControllerFiles(SRC_ROOT).flatMap(parseControllerFile);
  // Порог — по контроллерам, которые разбор признал, а не по файлам: сломанное узнавание
  // `@Controller` иначе прошло бы порог на одном числе файлов.
  return {
    ...offencesIn(parsed, (id) => PUBLIC_CACHE_HANDLERS.includes(id)),
    controllers: parsed.length,
  };
};

/**
 * Причины нарушений в синтетическом контроллере; обработчиком считается любой метод.
 * Декораторы Nest, допустимые на обработчике, импортируются в каждый вход заранее —
 * допустимым считается только импортированное; импорт ниже в самом входе перекрывает этот.
 */
const FIXTURE_NEST =
  "import { Controller, Get, Header, HttpCode, UseGuards, UseInterceptors } from '@nestjs/common';\n";

const reasonsFor = (code: string): string[] =>
  offencesIn(controllersIn(parseSource(FIXTURE_NEST + code), 'fixture'), () => true).offenders.map(
    (offender) => offender.reason,
  );

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

  /**
   * Глобальный гвард действует на любой обработчик, и в тексте контроллера его
   * не видно. Список явный: новый глобальный гвард — решение, а не побочный
   * эффект правки `app.module.ts`.
   */
  it('глобальные гварды — ровно из явного списка', () => {
    expect(globalGuards().sort()).toEqual([...GLOBAL_GUARDS].sort());
  });
});

/**
 * 🔴 Проверка выше на дереве, где нарушений нет, зелёная и у сломанного
 * детектора: опечатка в имени модуля даёт пустую карту импортов, и сторож
 * молча ничего не ловит (`L-017`, `L-033`). Поэтому каждый вид нарушения
 * прогоняется на синтетическом контроллере — и чистый вход рядом.
 */
describe('детектор краснеет на каждом виде нарушения', () => {
  const COMMON = [
    "import { Controller, Get, Headers, Ip, Query, Param, Req, Next, Request, Res, Response, Session, UseGuards } from '@nestjs/common';",
    "import { LanguageResolverGuard } from '../../common/guards/language-resolver.guard';",
  ].join('\n');
  const handler = (decorators: string, params = ''): string =>
    `${COMMON}\n@Controller() class C { @Get() ${decorators} handler(${params}) {} }`;
  const GUARD_ON_METHOD = (name: string): string[] => [
    `@UseGuards(${name}) на методе — гвард того, кто спрашивает`,
  ];

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
      GUARD_ON_METHOD('OptionalJwtAuthGuard'),
    ],
    [
      'new JwtAuthGuard() на методе',
      handler('@UseGuards(new JwtAuthGuard())'),
      GUARD_ON_METHOD('JwtAuthGuard'),
    ],
    [
      "AuthGuard('jwt') на методе",
      handler("@UseGuards(AuthGuard('jwt'))"),
      GUARD_ON_METHOD('AuthGuard'),
    ],
    [
      'MetricsAccessGuard на методе',
      handler('@UseGuards(MetricsAccessGuard)'),
      GUARD_ON_METHOD('MetricsAccessGuard'),
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
      '@Query() из чужого пространства имён — не @nestjs/common',
      "import * as other from '@nestjs/common-x';\n@Controller() class C { @Get() handler(@other.Query() q: unknown) {} }",
      ['@other.Query() — декоратор параметра вне списка допустимых'],
    ],
    [
      '@Req() из @nestjs/common с расширением в пути импорта',
      "import { Req } from '@nestjs/common/index.js';\n@Controller() class C { @Get() handler(@Req() r: unknown) {} }",
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
      GUARD_ON_METHOD('JwtAuthGuard'),
    ],
    [
      '@common.UseGuards при импорте пространством имён',
      "import * as common from '@nestjs/common';\n@common.Controller() class C { @common.Get() @common.UseGuards(JwtAuthGuard) handler() {} }",
      GUARD_ON_METHOD('JwtAuthGuard'),
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
      '@Language() из пути с расширением',
      "import { Language } from '../../common/decorators/language.decorator.js';\n@Controller() class C { @Get() handler(@Language() l: string) {} }",
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
      GUARD_ON_METHOD('OptionalJwtAuthGuard'),
    ],
    [
      'UseGuards под псевдонимом',
      "import { Controller, Get, UseGuards as G } from '@nestjs/common';\n@Controller() class C { @Get() @G(JwtAuthGuard) handler() {} }",
      GUARD_ON_METHOD('JwtAuthGuard'),
    ],
    ['RolesGuard на методе', handler('@UseGuards(RolesGuard)'), GUARD_ON_METHOD('RolesGuard')],
    [
      'RightsAgentTokenGuard на методе',
      handler('@UseGuards(RightsAgentTokenGuard)'),
      GUARD_ON_METHOD('RightsAgentTokenGuard'),
    ],
    // — краевые входы, на которые общий разбор раньше был слеп (`T108`) —
    [
      'свой Query, объявленный в файле',
      'const Query = createParamDecorator(() => 1);\n@Controller() class C { @Get() handler(@Query() l: string) {} }',
      ['@Query() — декоратор параметра вне списка допустимых'],
    ],
    [
      'свой NoPublicCache из чужого модуля',
      "import { NoPublicCache } from './auth.decorator';\n@Controller() class C { @Get() @NoPublicCache() handler() {} }",
      [
        '@NoPublicCache() на методе — декоратор вне списка допустимых (составной декоратор мог положить гвард)',
      ],
    ],
    [
      'свой глагол, объявленный в файле',
      'const Post = () => applyDecorators();\n@Controller() class C { @Post() handler() {} }',
      [
        '@Post() на методе — декоратор вне списка допустимых (составной декоратор мог положить гвард)',
      ],
    ],
    [
      'заголовок через приведение типа в теле метода',
      handler('', 'q: unknown').replace(
        '{} }',
        "{ return (req.headers as Record<string, string>)['x-foo']; } }",
      ),
      ["headers['x-foo'] в теле метода"],
    ],
    [
      'заголовок вне списка допустимых',
      handler('', "@Headers('x-real-ip') ip: string"),
      ["@Headers('x-real-ip') — заголовок вне списка допустимых"],
    ],
    [
      "req.headers['user-agent'] в теле метода",
      handler('', 'q: unknown').replace('{} }', "{ return req.headers['user-agent']; } }"),
      ["headers['user-agent'] в теле метода"],
    ],
    [
      'свой LanguageResolverGuard из чужого модуля',
      "import { LanguageResolverGuard } from '../evil.guard';\n@Controller() class C { @Get() @UseGuards(LanguageResolverGuard) handler() {} }",
      ['@UseGuards(LanguageResolverGuard) на методе — гвард вне списка допустимых'],
    ],
    [
      'LanguageResolverGuard из одноимённого файла в чужом каталоге',
      "import { LanguageResolverGuard } from '../evil/language-resolver.guard';\n@Controller() class C { @Get() @UseGuards(LanguageResolverGuard) handler() {} }",
      ['@UseGuards(LanguageResolverGuard) на методе — гвард вне списка допустимых'],
    ],
    [
      'LanguageResolverGuard, объявленный в файле, а не импортированный',
      'class LanguageResolverGuard {}\n@Controller() class C { @Get() @UseGuards(LanguageResolverGuard) handler() {} }',
      ['@UseGuards(LanguageResolverGuard) на методе — гвард вне списка допустимых'],
    ],
    [
      'свой PublicCacheInterceptor из чужого модуля',
      "import { UseInterceptors } from '@nestjs/common';\nimport { PublicCacheInterceptor } from '../evil';\n@Controller() class C { @Get() @UseInterceptors(PublicCacheInterceptor) handler() {} }",
      ['@UseInterceptors(PublicCacheInterceptor) на методе — интерцептор вне списка допустимых'],
    ],
    [
      'псевдоним импорта самого гварда',
      "import { JwtAuthGuard as G } from '../guards/jwt-auth.guard';\n@Controller() class C { @Get() @UseGuards(G) handler() {} }",
      GUARD_ON_METHOD('JwtAuthGuard'),
    ],
    [
      'гвард пользователя под именем допустимого',
      "import { JwtAuthGuard as LanguageResolverGuard } from '../guards/jwt-auth.guard';\n@Controller() class C { @Get() @UseGuards(LanguageResolverGuard) handler() {} }",
      GUARD_ON_METHOD('JwtAuthGuard'),
    ],
    [
      'гвард из массива в @UseGuards',
      handler('@UseGuards([LanguageResolverGuard, JwtAuthGuard])'),
      GUARD_ON_METHOD('JwtAuthGuard'),
    ],
    [
      'новый гвард вне списка допустимых',
      handler('@UseGuards(SomeNewGuard)'),
      ['@UseGuards(SomeNewGuard) на методе — гвард вне списка допустимых'],
    ],
    [
      'гвард, переданный spread-ом',
      handler('@UseGuards(...GUARDS)'),
      ['@UseGuards(...GUARDS) на методе — гвард не разобрать'],
    ],
    [
      'гвард, выбранный условием',
      handler('@UseGuards(flag ? A : B)'),
      ['@UseGuards(flag ? A : B) на методе — гвард не разобрать'],
    ],
    [
      'неизвестный параметр-декоратор',
      handler('', '@Custom() x: string'),
      ['@Custom() — декоратор параметра вне списка допустимых'],
    ],
    [
      '@Body() на публично кэшируемом обработчике',
      handler('', '@Body() dto: unknown'),
      ['@Body() — декоратор параметра вне списка допустимых'],
    ],
    [
      'составной декоратор на методе (applyDecorators)',
      handler('@Auth()'),
      [
        '@Auth() на методе — декоратор вне списка допустимых (составной декоратор мог положить гвард)',
      ],
    ],
    [
      'составной декоратор на классе',
      `${COMMON}\n@Auth() @Controller() class C { @Get() a() {} }`,
      [
        '@Auth() на классе — декоратор вне списка допустимых (составной декоратор мог положить гвард)',
      ],
    ],
    [
      'свой ApiAuth() не из @nestjs/swagger',
      "import { ApiAuth } from '../decorators/api-auth.decorator';\n@Controller() class C { @Get() @ApiAuth() handler() {} }",
      [
        '@ApiAuth() на методе — декоратор вне списка допустимых (составной декоратор мог положить гвард)',
      ],
    ],
    [
      'интерцептор вне списка допустимых',
      "import { UseInterceptors } from '@nestjs/common';\n@Controller() class C { @Get() @UseInterceptors(SomeInterceptor) handler() {} }",
      ['@UseInterceptors(SomeInterceptor) на методе — интерцептор вне списка допустимых'],
    ],
    [
      'базовый класс контроллера',
      `${COMMON}\n@Controller() class C extends Base { @Get() a() {} }`,
      ['класс наследует базовый — его декораторы и гварды не разобрать'],
    ],
    [
      '@Inject(REQUEST) в конструкторе',
      "import { Inject } from '@nestjs/common';\nimport { REQUEST } from '@nestjs/core';\n@Controller() class C { constructor(@Inject(REQUEST) private readonly req: unknown) {} @Get() a() {} }",
      ['@Inject(REQUEST) в конструкторе — запрос того, кто спрашивает'],
    ],
    [
      '@Inject(REQUEST) в свойстве под псевдонимом',
      "import { Inject as I } from '@nestjs/common';\nimport { REQUEST } from '@nestjs/core';\n@Controller() class C { @I(REQUEST) req: unknown; @Get() a() {} }",
      ['@Inject(REQUEST) в свойстве класса — запрос того, кто спрашивает'],
    ],
    [
      'параметры контроллера константой',
      `${COMMON}\n@Controller(CTRL_OPTIONS) class C { @Get() a() {} }`,
      ['@Controller(CTRL_OPTIONS) — параметры контроллера не разобрать (мог быть scope)'],
    ],
    [
      'scope в литерале с as const',
      `${COMMON}\n@Controller({ path: 'x', scope: Scope.REQUEST } as const) class C { @Get() a() {} }`,
      ['@Controller({ scope }) — контроллер на запрос получает запрос того, кто спрашивает'],
    ],
    [
      'scope ключом в кавычках',
      `${COMMON}
@Controller({ 'scope': Scope.REQUEST }) class C { @Get() a() {} }`,
      ['@Controller({ scope }) — контроллер на запрос получает запрос того, кто спрашивает'],
    ],
    [
      'параметры контроллера через spread',
      `${COMMON}
@Controller({ ...options }) class C { @Get() a() {} }`,
      ['@Controller({ scope }) — контроллер на запрос получает запрос того, кто спрашивает'],
    ],
    [
      'контроллер с областью видимости запроса',
      `${COMMON}\n@Controller({ path: 'x', scope: Scope.REQUEST }) class C { @Get() a() {} }`,
      ['@Controller({ scope }) — контроллер на запрос получает запрос того, кто спрашивает'],
    ],
  ])('%s', (_name, code, reasons) => {
    expect(reasonsFor(code)).toEqual(reasons);
  });

  it('текст соседнего декоратора не подменяет @UseGuards', () => {
    const code = handler(
      "@ApiOperation({ description: 'no @UseGuards() needed' }) @UseGuards(JwtAuthGuard)",
    ).replace(COMMON, `${COMMON}\nimport { ApiOperation } from '@nestjs/swagger';`);
    expect(reasonsFor(code)).toEqual(GUARD_ON_METHOD('JwtAuthGuard'));
  });

  it('чужой пакет с похожим именем — не @nestjs/common (L-008), но и не допустим', () => {
    const code =
      "import { Req, UseGuards } from '@nestjs/common-x';\n@Controller() class C { @Get() @UseGuards(LanguageResolverGuard) handler(@Req() r: unknown) {} }";
    // Не `@Req()` и не `@UseGuards` из Nest — запрет по имени их не касается, —
    // но и в список допустимого они не входят.
    expect(reasonsFor(code)).toEqual([
      '@Req() — декоратор параметра вне списка допустимых',
      '@UseGuards() на методе — декоратор вне списка допустимых (составной декоратор мог положить гвард)',
    ]);
  });

  it('чистый обработчик проходит: query, param, гвард языка, тип Request из express', () => {
    const code = [
      COMMON,
      "import type { Request as ExpressRequest } from 'express';",
      '@UseGuards(LanguageResolverGuard) @Controller() class C {',
      '  @Get() handler(@Query() q: unknown, @Param("x") x: string, r?: ExpressRequest) {}',
      '}',
    ].join('\n');
    expect(reasonsFor(code)).toEqual([]);
  });

  it('чистый обработчик проходит: документация, ручной заголовок кэша, безопасный заголовок запроса', () => {
    const code = [
      COMMON,
      "import { Header, HttpCode, UseInterceptors } from '@nestjs/common';",
      "import { ApiOperation, ApiOkResponse } from '@nestjs/swagger';",
      "import { NoPublicCache } from '../decorators/no-public-cache.decorator';",
      "import { PublicCacheInterceptor } from '../interceptors/public-cache.interceptor';",
      "@ApiOperation({ summary: 'x' }) @UseInterceptors(PublicCacheInterceptor) @Controller({ path: 'x' }) class C {",
      "  @Get() @Header('Cache-Control', 'public') @HttpCode(200) @NoPublicCache() @ApiOkResponse() handler(@Param('slug') slug: string) {}",
      '}',
    ].join('\n');
    expect(reasonsFor(code)).toEqual([]);
  });

  it('свойство класса — не REQUEST: @Inject(SERVICE) проходит', () => {
    const code =
      "import { Inject } from '@nestjs/common';\n@Controller() class C { constructor(@Inject(SERVICE) private readonly s: unknown) {} @Get() a() {} }";
    expect(reasonsFor(code)).toEqual([]);
  });
});

describe('глобальные гварды находятся во всех формах объявления', () => {
  const namesIn = (code: string): string[] => globalGuardsIn(parseSource(code, 'fixture.ts'));

  it.each([
    ['useClass', 'const p = { provide: APP_GUARD, useClass: A };', ['A']],
    ['useExisting', 'const p = { provide: APP_GUARD, useExisting: B };', ['B']],
    ['ключи в кавычках', "const p = { 'provide': APP_GUARD, 'useClass': A };", ['A']],
    ['фабрика', 'const p = { provide: APP_GUARD, useFactory: () => new C() };', ['<фабрика>']],
    [
      'APP_GUARD под псевдонимом импорта',
      "import { APP_GUARD as G } from '@nestjs/core';\nconst p = { provide: G, useClass: A };",
      ['A'],
    ],
    [
      'класс гварда под псевдонимом импорта',
      "import { JwtAuthGuard as J } from '../jwt';\nconst p = { provide: APP_GUARD, useClass: J };",
      ['JwtAuthGuard'],
    ],
    ['useGlobalGuards', 'app.useGlobalGuards(new A(), B);', ['A', 'B']],
    ['useGlobalGuards из массива', 'app.useGlobalGuards(...[A]);', ['<выражение>']],
    [
      'другой глобальный провайдер — не гвард',
      'const p = { provide: APP_INTERCEPTOR, useClass: Z };',
      [],
    ],
  ])('%s', (_name, code, names) => {
    expect(namesIn(code)).toEqual(names);
  });
});
