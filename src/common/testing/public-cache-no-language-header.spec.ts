import { readFileSync } from 'fs';
import * as ts from 'typescript';
import { SRC_ROOT, listControllerFiles, relativeToSrc } from './controller-decorators';
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

/** Имена запрещённых декораторов **в этом файле**, с учётом псевдонимов импорта. */
const forbiddenDecoratorNames = (source: ts.SourceFile): Map<string, string> => {
  const names = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const from = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const exported = (element.propertyName ?? element.name).text;
      const match = HEADER_DECORATORS.find(
        (candidate) => candidate.name === exported && from.includes(candidate.module),
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

type Offender = { id: string; reason: string };

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
    const where = relativeToSrc(file);
    const forbidden = forbiddenDecoratorNames(source);

    source.forEachChild((node) => {
      if (!ts.isClassDeclaration(node)) return;
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !member.name) continue;
        const id = `${where} → ${member.name.getText()}`;
        if (!PUBLIC_CACHE_HANDLERS.includes(id)) continue;
        seen.push(id);

        for (const parameter of member.parameters) {
          const reason = parameterOffence(parameter, forbidden);
          if (reason) offenders.push({ id, reason });
        }
        for (const reason of bodyOffences(member)) offenders.push({ id, reason });
      }
    });
  }

  return { offenders, controllers: files.length, seen };
};

describe('публично кэшируемый ответ не зависит от заголовка запроса', () => {
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

  it('ни один из них не читает Accept-Language и прочие заголовки запроса', () => {
    expect(offenders.map((offender) => `${offender.id}: ${offender.reason}`)).toEqual([]);
  });
});
