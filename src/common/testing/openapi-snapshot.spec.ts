import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module';
import { buildOpenApiDocument } from '../../config/openapi.config';
import { SRC_ROOT } from './controller-decorators';
import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * Снапшот публичного контракта: собранная схема OpenAPI против закоммиченной
 * (`LEGACY-016`, пункт «OpenAPI-diff»).
 *
 * Зачем. До этой спеки схему нигде не сверяли: `scripts/generate-openapi-schema.js`
 * умеет её скачать с живого сервера, но результат никуда не коммитился, и
 * снятое поле ответа, переименованный параметр или уехавший код ошибки
 * не оставляли следа ни в диффе, ни в прогоне. Теперь любая правка контроллера
 * или DTO, меняющая контракт, краснеет здесь и приходит в ревью строкой диффа
 * снапшота — то есть контракт виден человеку, а не только клиенту на проде.
 *
 * Почему спекой, а не шагом конвейера: спека едет внутри `yarn test:cov`, то
 * есть и в `scripts/ci.sh`, и в `deploy.yml`. Отдельный шаг пришлось бы завести
 * дважды, и забытая половина расходится молча — этим уже кончились
 * `LEGACY-078`, `LEGACY-207` и `LEGACY-209`.
 *
 * 🔴 Приложение поднимается в **preview-режиме** (`NestFactory.create(AppModule,
 * { preview: true })`): граф модулей строится, а провайдеры не создаются вовсе.
 * Обычный `compile()` здесь был бы отказом на чужой машине и порчей данных
 * на своей — фабрики исполняются на сборке контейнера: `JwtModule.registerAsync`
 * требует `JWT_ACCESS_SECRET`, которого в юнит-job'ах CI нет; `queue.module.ts`
 * открывает `IORedis`; `media-jobs.module.ts` ставит повторяемое задание
 * `media-cleanup` и поднимает воркеры, а тот cleanup удаляет строки `MediaAsset`
 * и файлы в хранилище по адресам из окружения. Preview-режим не создаёт ни одного
 * из них, а Swagger читает метаданные контроллеров, а не их экземпляры.
 *
 * Ходить за схемой на живой сервер нельзя — сверка тогда зависела бы от того,
 * что на нём сейчас развёрнуто.
 *
 * **Как обновить снапшот после осознанной смены контракта:**
 * `yarn openapi:snapshot`, затем прочитать дифф файла глазами: он и есть
 * описание того, что увидит клиент. В CI переменная обновления игнорируется —
 * сторож, переписывающий своё ожидание, покраснеть не может никогда.
 */

const SNAPSHOT = resolve(SRC_ROOT, '../libs/api-client/api-schema.json');

/** Ниже этого числа маршрутов схема собралась не целиком, а обрезанной. */
const MIN_PATHS = 240;

/**
 * Ключи по алфавиту, отступ два пробела — форма файла, а не сверки: дифф
 * снапшота читает человек. Сверка идёт `toEqual` по разобранным объектам
 * и порядка ключей не замечает вовсе.
 */
const stableJson = (value: unknown): string => {
  const sorted = (inner: unknown): unknown => {
    if (Array.isArray(inner)) return inner.map(sorted);
    if (inner !== null && typeof inner === 'object') {
      return Object.fromEntries(
        Object.entries(inner as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, nested]) => [key, sorted(nested)]),
      );
    }
    return inner;
  };
  return `${JSON.stringify(sorted(value), null, 2)}\n`;
};

// Пробы на отказ живут внутри того же `describe`: им нужен **собранный**
// документ, а не копия закоммиченного файла. Мутация файла против него же
// проверяла бы `toEqual`, а не сторожа — сверка при этом могла бы уехать
// на сравнение ключей и остаться зелёной (`L-004`, `L-016`).

type Paths = { paths: Record<string, Record<string, unknown>> };

const mutated = (document: unknown, change: (copy: Paths) => void): Paths => {
  const copy = JSON.parse(JSON.stringify(document)) as Paths;
  change(copy);
  return copy;
};

describe('снапшот OpenAPI совпадает с собранной схемой', () => {
  let built: unknown;

  beforeAll(async () => {
    // `abortOnError: false` обязателен: иначе отказ построения графа Nest
    // не бросает исключение, а зовёт `process.abort()`, и jest печатает
    // «worker process was terminated by another process: signal=SIGABRT»
    // вместо причины — вместе с этим воркером падают и остальные спеки
    // его очереди. `logger: ['error']` оставляет саму причину видимой.
    const app = await NestFactory.create(AppModule, {
      preview: true,
      abortOnError: false,
      logger: ['error'],
    });
    const document: OpenAPIObject = buildOpenApiDocument(app);
    built = JSON.parse(JSON.stringify(document));
    await app.close();
  }, 120000);

  it(`собирает схему не меньше чем на ${MIN_PATHS} маршрутов`, () => {
    expect(Object.keys((built as OpenAPIObject).paths).length).toBeGreaterThanOrEqual(MIN_PATHS);
  });

  it('совпадает с закоммиченным снапшотом', () => {
    // Обновление снапшота — действие разработчика, а не побочный эффект
    // прогона: в CI переменная игнорируется, иначе сторож переписывал бы
    // ожидание под изменившийся код и не мог бы покраснеть никогда.
    if (process.env.UPDATE_OPENAPI_SNAPSHOT === '1' && process.env.CI !== 'true') {
      writeFileSync(SNAPSHOT, stableJson(built), 'utf8');
    }

    const committed: unknown = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));

    expect(built).toEqual(committed);
  });

  it('проба на отказ: снятый маршрут в собранной схеме краснеет', () => {
    const committed: unknown = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
    const broken = mutated(built, (copy) => {
      const [route] = Object.keys(copy.paths);
      delete copy.paths[route];
    });

    expect(broken).not.toEqual(committed);
  });

  it('проба на отказ: снятые ответы маршрута краснеют — дефект, ради которого заведён', () => {
    const committed: unknown = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
    const broken = mutated(built, (copy) => {
      const [route] = Object.keys(copy.paths);
      const [method] = Object.keys(copy.paths[route]);
      delete (copy.paths[route][method] as Record<string, unknown>).responses;
    });

    expect(broken).not.toEqual(committed);
  });

  it('проба на отказ: переименованный параметр запроса краснеет', () => {
    const committed: unknown = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
    const broken = mutated(built, (copy) => {
      const entry = Object.values(copy.paths)
        .flatMap((methods) => Object.values(methods))
        .find(
          (operation): operation is { parameters: { name: string }[] } =>
            Array.isArray((operation as { parameters?: unknown }).parameters) &&
            (operation as { parameters: unknown[] }).parameters.length > 0,
        );
      if (!entry) throw new Error('в схеме нет ни одного параметра — разбор пробы сломан');
      entry.parameters[0].name = `${entry.parameters[0].name}_renamed`;
    });

    expect(broken).not.toEqual(committed);
  });
});
