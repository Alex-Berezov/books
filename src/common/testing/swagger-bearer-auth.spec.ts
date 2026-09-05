import { SRC_ROOT, collectRoutes, listControllerFiles } from './controller-decorators';
import type { ControllerRoute } from './controller-decorators';

/**
 * Сторож связки «`JwtAuthGuard` — `@ApiBearerAuth()`» (`LEGACY-132`).
 *
 * Декоратор не влияет на исполнение запроса вовсе: он влияет только на
 * сгенерированный документ OpenAPI. Поэтому его пропуск не ловят ни типы, ни
 * линт, ни тесты маршрутов — закрытый маршрут просто выглядит в Swagger
 * открытым, а кнопка проверки не подставляет токен и отвечает 401, что читается
 * как поломка маршрута.
 *
 * ⚠️ Проверка двусторонняя, и вторая половина не менее важна первой. Дословная
 * рекомендация записи — «поставить декоратор на класс» — на смешанном
 * контроллере пометила бы токеном и публичные `GET`: та же ложь в документе, с
 * обратным знаком. Из одиннадцати контроллеров, которые правились по этой
 * записи, **ни один** не был защищён целиком (решение арбитра 05.09.2026,
 * `decisions-log.md`), поэтому декоратор ставится ровно туда, где стоит гвард.
 *
 * ⚠️ Маршруты под `OptionalJwtAuthGuard` из второй половины исключены: такой
 * маршрут пускает анонима, но токен на нём осмыслен и меняет ответ, поэтому
 * `@ApiBearerAuth()` там не ложь. Исключение задано **гвардом**, а не списком
 * имён файлов: список пришлось бы дополнять при каждом новом маршруте, и первый
 * же незаполненный случай выглядел бы как нарушение.
 *
 * Разбор берётся из `controller-decorators.ts` — того же сканера, что стережёт
 * `@Roles`/`RolesGuard` (`roles-guard-wiring.spec.ts`) и порядок маршрутов.
 * Второго разбора контроллеров здесь нет намеренно: два сторожа с разными
 * ответами на один вход хуже одного.
 */

/** Ниже этих чисел сломан обход, а не поредел репозиторий. */
const MIN_CONTROLLERS = 40;
const MIN_CLOSED_ROUTES = 150;

const describeRoute = (route: ControllerRoute): string =>
  `${route.file} → ${route.verb.toUpperCase()} ${route.path} (${route.ownerLine})`;

const routeKey = (route: ControllerRoute): string =>
  `${route.file} ${route.verb} ${route.path} ${route.ownerLine}`;

describe('JwtAuthGuard and @ApiBearerAuth() agree with each other', () => {
  const controllers = listControllerFiles(SRC_ROOT);
  const jwt = collectRoutes('JwtAuthGuard');
  const optional = collectRoutes('OptionalJwtAuthGuard');
  const optionalKeys = new Set(optional.closed.map(routeKey));

  const closedWithoutDecorator = jwt.closed.filter((route) => !route.bearerAuth).map(describeRoute);

  const openWithDecorator = jwt.open
    .filter((route) => route.bearerAuth && !optionalKeys.has(routeKey(route)))
    .map(describeRoute);

  it(`находит не меньше ${MIN_CONTROLLERS} контроллеров`, () => {
    expect(controllers.length).toBeGreaterThanOrEqual(MIN_CONTROLLERS);
  });

  it(`находит не меньше ${MIN_CLOSED_ROUTES} закрытых маршрутов`, () => {
    expect(jwt.closed.length).toBeGreaterThanOrEqual(MIN_CLOSED_ROUTES);
  });

  it('разбирает каждый контроллер — ни один не пропущен молча', () => {
    expect(jwt.skipped).toEqual([]);
  });

  it('не оставляет ни одного закрытого маршрута без @ApiBearerAuth', () => {
    expect(closedWithoutDecorator).toEqual([]);
  });

  it('не помечает @ApiBearerAuth ни одного маршрута без гварда авторизации', () => {
    expect(openWithDecorator).toEqual([]);
  });
});
