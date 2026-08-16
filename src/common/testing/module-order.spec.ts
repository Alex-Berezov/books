import { resolve } from 'path';
import { registrationOf } from './module-registration';

/**
 * Сторож порядка модулей (`LEGACY-201`).
 *
 * `PublicModule` — единственный, чей контроллер объявлен как `@Controller(':lang')`:
 * параметр в первом сегменте перехватывает **любой** литеральный путь той же
 * длины, зарегистрированный позже. Пока `PublicModule` стоял в `imports` выше
 * `AuthorModule`, `GET /admin/authors` уезжал в `:lang/authors`, `LangParamPipe`
 * получал `lang = 'admin'` и отвечал 404 — маршрут админки был мёртв, а в логе
 * был обычный 404.
 *
 * Инвариант: **ловушка `:lang` регистрируется после всех, кто объявляет
 * литеральные пути.** Ни `tsc`, ни линт, ни сборка его не видят — приложение
 * стартует и со сломанным порядком, Swagger показывает оба маршрута. Поэтому он
 * закреплён здесь, а не комментарием.
 *
 * Проверяется место в **очереди регистрации**, а не строка в массиве `imports`:
 * модуль, импортированный соседом, регистрируется там, где его увидели первым,
 * поэтому `PublicModule`, попавший в чей-нибудь `imports`, уехал бы вверх, стоя
 * в `app.module.ts` последним. Как считается очередь — в `module-registration.ts`.
 *
 * Эта спека называет **виновника** перестановки; какие именно маршруты от неё
 * умерли, называет `route-order.spec.ts`.
 */

const SRC_ROOT = resolve(__dirname, '../..');

/** Ниже этого числа сломан разбор, а не репозиторий поредел (приём из `route-order.spec.ts`). */
const MIN_MODULES_WITH_CONTROLLERS = 30;

/** Модуль, который обязан регистрироваться последним, и причина — в шапке файла. */
const MUST_BE_LAST = 'PublicModule';

describe('порядок модулей: ловушка :lang регистрируется последней', () => {
  const { order, problems } = registrationOf(SRC_ROOT);
  const withControllers = order.filter((module) => module.controllers.length > 0);

  it('предпосылки разбора в силе: каждый контроллер найден по импорту своего модуля', () => {
    expect(problems).toEqual([]);
  });

  it(`находит не меньше ${MIN_MODULES_WITH_CONTROLLERS} модулей с контроллерами`, () => {
    expect(withControllers.length).toBeGreaterThanOrEqual(MIN_MODULES_WITH_CONTROLLERS);
  });

  // Сравнение именно на равенство последнего элемента, а не `indexOf` с
  // «больше»: сообщение об ошибке обязано назвать виновника — тот модуль,
  // который зарегистрировался позже `PublicModule` и потерял свои литеральные
  // маршруты.
  it(`${MUST_BE_LAST} регистрируется последним среди модулей с контроллерами`, () => {
    expect(withControllers[withControllers.length - 1]?.name).toEqual(MUST_BE_LAST);
  });
});
