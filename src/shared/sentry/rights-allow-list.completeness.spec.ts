import { PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { DECORATORS } from '@nestjs/swagger/dist/constants';

import { listControllerFiles } from '../../common/testing/controller-decorators';
import { normalizeKey } from './redact.util';
import { ALLOW_LIST_PATH_PATTERN, RIGHTS_ALLOW_LIST } from './rights-allow-list';

/**
 * Полнота состава `RIGHTS_ALLOW_LIST` (`LEGACY-338`).
 *
 * 🔴 Соседняя `rights-allow-list.spec.ts` проверяет список в одну сторону:
 * что каждая его строка достижима и нормализована. Обратной стороны — поле,
 * заведённое в DTO и забытое в списке, — не проверял никто, а цена у неё
 * та же: под белым списком незаявленное поле становится `[Filtered]`,
 * компилятор молчит, спеки зелены, и событие 500 по правовой ручке приходит
 * телом из одних меток. Выясняется это на боевом отказе.
 *
 * 🔴 Ручного реестра DTO здесь нет намеренно. Реестр разошёлся бы с кодом
 * ровно тем же молчанием, ради устранения которого заводится: это была бы
 * третья копия после самого списка и самих DTO. Вместо него — обнаружение:
 * маршруты находятся по **импортированной** из фильтра `ALLOW_LIST_PATH_PATTERN`
 * (границу маршрутов задаёт одно место, и счёт контроллеров меняется сам),
 * поля — рефлексией по метаданным, которые Nest и Swagger уже пишут.
 * Решение арбитра от 01.09.2026.
 *
 * ⚠️ Рантайм `shared/sentry/**` доменные модули по-прежнему не импортирует.
 * Импорт контроллеров живёт **только здесь**, в спеке, и в сборку не попадает.
 *
 * ⚠️ Рефлексия работает потому, что `nest-cli.json` не подключает
 * swagger-плагин: `@ApiProperty` проставлены руками на каждом поле, и
 * `API_MODEL_PROPERTIES_ARRAY` отдаёт полный состав, а не выборку.
 */

/**
 * Поля, которые под белым списком гасятся **намеренно**, — снимок, а не список
 * разрешений. Красное направление «поле есть, а в списке нет» чинится записью
 * либо сюда, либо в `RIGHTS_ALLOW_LIST` — по закрытому критерию отбора.
 *
 * 🔴 Свободная строка идёт **только сюда** и никогда в белый список: решение
 * арбитра от 30.08.2026. Каждое имя ниже сопровождено причиной, потому что
 * снимок без причин через полгода читается как «когда-то так вышло».
 */
const FILTERED_BY_DESIGN: ReadonlyMap<string, string> = new Map([
  // Проза без потолка длины — то, ради чего белый список и заведён.
  ['description', 'свободный текст'],
  ['description_ru', 'свободный текст'],
  ['claimed_rights_description_ru', 'свободный текст'],
  ['short_description', 'свободный текст'],
  ['summary_short', 'свободный текст'],
  ['counter_notice_text_ru', 'свободный текст: встречное уведомление DMCA'],
  ['original_notice_text', 'свободный текст: исходное уведомление'],
  ['response_text_ru', 'свободный текст'],
  ['internal_notes_ru', 'свободный текст'],
  ['notes_ru', 'свободный текст'],
  ['completion_notes_ru', 'свободный текст'],
  ['resolution_notes_ru', 'свободный текст'],
  ['reason_ru', 'свободный текст'],
  ['lift_reason_ru', 'свободный текст'],
  ['royalty_terms_ru', 'свободный текст'],
  ['other_conditions_ru', 'свободный текст'],
  ['blocks_publication_override_reason_ru', 'свободный текст'],
  ['required_attribution_text', 'свободный текст'],
  ['title', 'свободный текст: название работы'],
  ['title_ru', 'свободный текст'],
  ['cover_alt', 'свободный текст'],
  ['claimed_work_title', 'свободный текст'],
  ['claimed_work_author', 'свободный текст: имя автора'],
  ['candidate_title', 'свободный текст'],
  ['candidate_author', 'свободный текст: имя автора'],
  ['original_title', 'свободный текст'],
  ['source_title', 'свободный текст'],
  ['author', 'свободный текст: имя автора'],
  ['licensor', 'свободный текст: сторона договора'],
  ['licensee', 'свободный текст: сторона договора'],
  ['rights_holder', 'свободный текст: правообладатель'],
  ['license_key', 'свободный текст: номер договора'],
  ['reference_number', 'свободный текст: номер документа'],
  ['file_name', 'свободный текст: имя файла'],
  ['slug', 'свободный текст'],
  ['q', 'свободный текст: поисковая строка (LEGACY-337)'],

  // Адреса и ключи хранилища: несут маршрут к файлу, а не признак разбора.
  ['url', 'адрес'],
  ['source_url', 'адрес'],
  ['original_notice_url', 'адрес'],
  ['referral_url', 'адрес'],
  ['author_page_url', 'адрес'],
  ['cover_image_url', 'адрес'],
  ['document_url', 'адрес'],
  ['infringing_urls', 'адреса'],
  ['storage_key', 'ключ объекта в хранилище'],
  ['document_storage_key', 'ключ объекта в хранилище'],
  ['sha256', 'контрольная сумма'],
  ['document_sha256', 'контрольная сумма'],

  // Гасятся маской раньше белого списка: до его ветки не доходят вовсе.
  ['claimant_type', 'слово `claimant` в персональной маске'],
  ['claimant_name', 'слово `claimant` в персональной маске'],
  ['claimant_email', 'почта: уходит хешем'],
  ['claimant_phone', 'слово `claimant` в персональной маске'],
  ['claimant_address', 'слово `claimant` в персональной маске'],
  ['claimant_organization', 'слово `claimant` в персональной маске'],
  ['claimant_is_authorized', 'слово `claimant` в персональной маске'],
  ['claimant_person_id', 'слово `claimant` в персональной маске'],
  ['counter_notice_claimant_name', 'слово `claimant` в персональной маске'],

  // Не имя поля: multipart и служебное.
  ['file', 'тело multipart, а не поле DTO'],
  ['versions', 'контейнер вложенных DTO; его поля перечислены по отдельности'],
  ['conditions', 'контейнер вложенных DTO; его поля перечислены по отдельности'],

  // Остальные семь контроллеров под `admin/rights`: список собирался
  // по шести, а префикс накрывает тринадцать (`LEGACY-338`).
  ['body_ru', 'свободный текст'],
  ['text_ru', 'свободный текст'],
  ['context_ru', 'свободный текст'],
  ['question_ru', 'свободный текст'],
  ['message_ru', 'свободный текст'],
  ['label_ru', 'свободный текст'],
  ['restrictions_ru', 'свободный текст'],
  ['specialization_ru', 'свободный текст'],
  ['opinion_summary_ru', 'свободный текст'],
  ['recheck_pause_reason_ru', 'свободный текст'],
  ['copyright_status', 'свободный текст: объявлен строкой, а не перечислением'],
  ['agent_model', 'свободный текст: имя модели приходит строкой'],
  [
    'allowed_schema_versions',
    'свободный текст: `@IsString({each:true})` без перечисления и без `@MaxLength`',
  ],
  ['source_file_name', 'свободный текст: имя файла'],
  ['raw_agent_output', 'свободный текст: вывод агента целиком'],
  ['report_json', 'свободный текст: отчёт целиком'],
  ['report_markdown', 'свободный текст: отчёт целиком'],

  // Персональные данные живого адвоката: гасятся маской раньше списка.
  ['email', 'почта: уходит хешем'],
  ['phone', 'слово `phone` в персональной маске'],
  ['full_name', 'слово `full_name` в персональной маске'],
  ['organization', 'слово `organization` в персональной маске'],
  ['bar_id', 'номер адвоката в реестре палаты: опознаёт живого человека'],

  // Секрет: гасится секретной маской словом `token`.
  ['token_id', 'секретная маска словом `token`; строка в списке была бы мертва'],
]);

/**
 * Вход, которого рефлексией не видно: имя задано литералом в интерцепторе,
 * а не декоратором параметра.
 */
const EXTRA_INPUTS: ReadonlyMap<string, string> = new Map([
  ['file', "FileInterceptor('file', …) в rights-files.controller.ts"],
  // 🔴 `lang` сторож объявил мёртвым, и по его вердикту строка была снята
  // из белого списка — ошибочно. `LanguageResolverGuard`
  // (`common/guards/language-resolver.guard.ts:32,38`) — глобальный `APP_GUARD`
  // и читает `req.params['lang']` и `req.query['lang']` на **каждом** запросе,
  // декоратора `@Query('lang')` при этом нет. Найдено ревью 01.09.2026.
  // Отсюда общее правило: у обнаружения по декораторам есть слепое пятно —
  // глобальные гварды и интерцепторы, и оно закрывается только этим набором.
  ['lang', 'глобальный LanguageResolverGuard читает req.params/req.query напрямую'],
]);

type AnyClass = new (...args: never[]) => object;

function isClass(value: unknown): value is AnyClass {
  return typeof value === 'function' && typeof (value as AnyClass).prototype === 'object';
}

function propertyNames(target: object): string[] {
  const raw =
    (Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES_ARRAY, target) as string[] | undefined) ??
    [];
  // Swagger хранит имена с ведущим двоеточием: `:claimType`.
  return raw.map((name) => name.replace(/^:/, ''));
}

/** Поля DTO вместе с полями вложенных DTO: белый список действует на любой глубине. */
function collectDtoFields(dto: AnyClass, seen: Set<AnyClass> = new Set()): string[] {
  if (seen.has(dto)) return [];
  seen.add(dto);

  const names = propertyNames(dto.prototype as object);
  const collected = [...names];
  for (const name of names) {
    const options = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      dto.prototype as object,
      name,
    ) as { type?: unknown } | undefined;
    // `@ApiProperty({ type: () => X })` и `{ type: X }` — обе формы живые.
    const declared = typeof options?.type === 'function' ? options.type : undefined;
    if (!declared) continue;
    const nested = isClass(declared) && propertyNames(declared.prototype as object).length > 0;
    if (nested) {
      collected.push(...collectDtoFields(declared, seen));
      continue;
    }
    // Форма-громоотвод `() => X`: вызываем и смотрим, не класс ли пришёл.
    let thunked: unknown;
    try {
      thunked = (declared as () => unknown)();
    } catch {
      thunked = undefined;
    }
    if (isClass(thunked) && propertyNames(thunked.prototype as object).length > 0) {
      collected.push(...collectDtoFields(thunked, seen));
    }
  }
  return collected;
}

/** Виды параметров обработчика, которые несут имена полей. */
const NAMED_PARAM_KINDS: ReadonlySet<number> = new Set<number>([
  RouteParamtypes.PARAM,
  RouteParamtypes.QUERY,
  RouteParamtypes.BODY,
]);

interface RouteInput {
  readonly controller: string;
  readonly handler: string;
  readonly path: string;
  readonly names: readonly string[];
}

function joinPath(classPath: unknown, methodPath: unknown): string {
  const parts = [classPath, methodPath]
    .map((part) => (typeof part === 'string' ? part : ''))
    .filter((part) => part !== '' && part !== '/');
  return `/${parts.join('/')}`;
}

function collectRouteInputs(): RouteInput[] {
  const routes: RouteInput[] = [];

  for (const file of listControllerFiles()) {
    // Загрузка динамическая по существу задачи: метаданные Nest и Swagger
    // живут только на загруженном классе, а список контроллеров вычисляется
    // обходом каталога — статическим импортом это и есть тот ручной реестр,
    // ради отсутствия которого сторож и написан. `await import()` здесь
    // не годится: `describe` собирается синхронно.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- метаданные Nest и Swagger живут только на загруженном классе, а список контроллеров вычисляется обходом каталога: статический импорт здесь и есть тот ручной реестр, ради отсутствия которого сторож написан, а `await import()` не годится - `describe` собирается синхронно
    const loaded = require(file) as Record<string, unknown>;
    for (const exported of Object.values(loaded)) {
      if (!isClass(exported)) continue;
      const classPath = Reflect.getMetadata(PATH_METADATA, exported) as unknown;
      if (classPath === undefined) continue;

      const proto = exported.prototype as object;
      const handlers = Object.getOwnPropertyNames(proto).filter((name) => name !== 'constructor');

      for (const handler of handlers) {
        const method = (proto as Record<string, unknown>)[handler];
        if (typeof method !== 'function') continue;
        const methodPath = Reflect.getMetadata(PATH_METADATA, method) as unknown;
        if (methodPath === undefined) continue;

        const path = joinPath(classPath, methodPath);
        if (!ALLOW_LIST_PATH_PATTERN.test(path)) continue;

        const names: string[] = [];
        const args =
          (Reflect.getMetadata(ROUTE_ARGS_METADATA, exported, handler) as
            | Record<string, { index: number; data?: unknown }>
            | undefined) ?? {};
        const paramTypes =
          (Reflect.getMetadata('design:paramtypes', proto, handler) as unknown[] | undefined) ?? [];

        for (const [key, meta] of Object.entries(args)) {
          // Ключ метаданных Nest — `<вид параметра>:<номер>`, вид приходит
          // числом. Набор собран из членов перечисления, а не сравнивается
          // с ними по одному: иначе число и член перечисления сопоставляются
          // напрямую, а это разные типы.
          const kind: number = Number(key.split(':')[0]);
          if (!NAMED_PARAM_KINDS.has(kind)) continue;

          if (typeof meta.data === 'string' && meta.data !== '') {
            // `@Param('id')` / `@Query('q')` — имя задано строкой.
            names.push(meta.data);
            continue;
          }
          // `@Body() dto` / `@Query() dto` — имя не задано, поля берутся из DTO.
          const declared = paramTypes[meta.index];
          if (isClass(declared) && propertyNames(declared.prototype as object).length > 0) {
            names.push(...collectDtoFields(declared));
          }
        }

        routes.push({ controller: exported.name, handler, path, names });
      }
    }
  }

  return routes;
}

describe('RIGHTS_ALLOW_LIST: полнота состава против входа маршрутов', () => {
  const routes = collectRouteInputs();
  const inputNames = new Set<string>();
  for (const route of routes) {
    for (const name of route.names) inputNames.add(normalizeKey(name));
  }
  for (const name of EXTRA_INPUTS.keys()) inputNames.add(normalizeKey(name));

  // Страховка от «проверено ноль единиц» по образцу `seo.controller.spec.ts:44-50`:
  // перестань рефлексия что-либо отдавать — обе сверки ниже прошли бы молча
  // и запись `LEGACY-338` снова оказалась бы открытой при зелёных спеках.
  describe('🔴 обнаружение вообще что-то нашло', () => {
    it('маршруты под `admin/rights` найдены', () => {
      expect(routes.length).toBeGreaterThan(20);
    });

    it('у найденных маршрутов есть имена полей', () => {
      expect(inputNames.size).toBeGreaterThan(100);
    });

    it('контроллеров под префиксом больше шести: границу задаёт регулярка, а не счёт', () => {
      // В записи `LEGACY-338` было сказано «шесть контроллеров». Их тринадцать,
      // и число тут ни при чём: маршруты выбирает `ALLOW_LIST_PATH_PATTERN`.
      const controllers = new Set(routes.map((route) => route.controller));

      expect(controllers.size).toBeGreaterThan(6);
    });
  });

  it('🔴 в списке нет строки, которой не соответствует ни один вход', () => {
    // Мёртвая строка читается как разрешение, но ничего не разрешает. Так уже
    // вышло с `claim_number` и `person_id` — они были внесены по **ответному**
    // DTO, которого ни одна ручка не принимает. Соседняя спека ловит другой
    // класс той же ошибки: строку, погашенную маской раньше списка.
    const dead = Array.from(RIGHTS_ALLOW_LIST).filter((key) => !inputNames.has(key));

    expect(dead).toEqual([]);
  });

  it('🔴 нет поля входа, о котором список не заявил ничего', () => {
    // Незаявленное поле уходит `[Filtered]` молча: компилятор о нём не знает,
    // а обнаруживается это на боевом отказе, где разбирать уже нечем.
    // Чинится внесением либо в `RIGHTS_ALLOW_LIST` (перечисление, идентификатор,
    // дата, булево, число), либо в `FILTERED_BY_DESIGN` (всё прочее, и свободная
    // строка — только сюда).
    const undeclared = Array.from(inputNames)
      .filter((key) => !RIGHTS_ALLOW_LIST.has(key) && !FILTERED_BY_DESIGN.has(key))
      .sort();

    expect(undeclared).toEqual([]);
  });

  it('снимок намеренно погашенного не разрастается мёртвыми строками', () => {
    const stale = Array.from(FILTERED_BY_DESIGN.keys())
      .filter((key) => !inputNames.has(key))
      .sort();

    expect(stale).toEqual([]);
  });

  it('🔴 ни одно имя не заявлено дважды: список и снимок не пересекаются', () => {
    // Пересечение означает, что одно и то же поле объявлено и разрешённым,
    // и намеренно погашенным — читатель поверит тому из двух, что найдёт первым.
    const both = Array.from(FILTERED_BY_DESIGN.keys())
      .filter((key) => RIGHTS_ALLOW_LIST.has(key))
      .sort();

    expect(both).toEqual([]);
  });
});
