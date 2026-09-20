import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma } from '@prisma/client';
import {
  CLEAR_LICENSE_SNAPSHOT,
  PRESERVED_LICENSE_COLUMNS,
  SNAPSHOT_COLUMNS_IGNORED_IN_COMPARISON,
  licenseSnapshotChanged,
  licenseSnapshotPayload,
  lockLicenseSnapshot,
  type RightsLicenseSnapshot,
} from './rights-license-snapshot';
import { SRC_ROOT, listFiles, relativeToSrc } from '../../common/testing/controller-decorators';

/**
 * Посадка общего модуля лицензионного снимка (`LEGACY-180`).
 *
 * Модуль держит то, что обязано совпадать у двух путей снятия версии с публикации —
 * админского `unpublish` и блокировки по претензии: список колонок, замок строки и форму
 * снимка в `payload` события. Разойдись любая из трёх вещей — один путь погасит четыре поля,
 * другой пять, и разницу не увидит ни один тест самих путей.
 */
describe('rights-license-snapshot', () => {
  const snapshot: RightsLicenseSnapshot = {
    status: 'published',
    publishedAt: new Date('2026-09-01T10:00:00.000Z'),
    rightsLicenseIds: ['lic-A', 'lic-B'],
    rightsLicenseCoverageStatus: 'COVERED',
    rightsLicenseCheckedAt: new Date('2026-09-01T09:59:00.000Z'),
    rightsLicenseUncoveredCountryCodes: ['BR'],
  };

  describe('состав снимка сверяется со схемой', () => {
    /**
     * Полнота списка против источника правды. Шестая колонка `rightsLicense*` в схеме,
     * о которой не знает ни гасимый набор, ни перечень сохраняемых, — это возврат
     * `LEGACY-180` на новой колонке при закрытой записи. Поэтому она красит эту спеку.
     */
    it('каждая колонка rightsLicense* схемы либо гасится, либо сохраняется явно', () => {
      const schema = readFileSync(join(__dirname, '../../../prisma/schema.prisma'), 'utf8');
      const modelStart = schema.indexOf('model BookVersion {');
      expect(modelStart).toBeGreaterThan(-1);
      // Границей блока служит закрывающая скобка модели в начале строки: искать её
      // по имени следующей модели нельзя — в схеме между ними лежат чужие связи
      // с теми же префиксами имён.
      const modelEnd = schema.indexOf('\n}', modelStart);
      const model = schema.slice(modelStart, modelEnd);
      const inSchema = [...model.matchAll(/^\s*(rightsLicense\w+)\s/gm)]
        .map((match) => match[1])
        .sort();
      expect(inSchema.length).toBeGreaterThan(0);

      const handled = [
        ...Object.keys(CLEAR_LICENSE_SNAPSHOT).filter((key) => key.startsWith('rightsLicense')),
        ...PRESERVED_LICENSE_COLUMNS,
      ].sort();

      expect(handled).toEqual(inSchema);
    });

    it('гасимые и сохраняемые наборы не пересекаются', () => {
      for (const preserved of PRESERVED_LICENSE_COLUMNS) {
        expect(CLEAR_LICENSE_SNAPSHOT).not.toHaveProperty(preserved);
      }
    });

    it('у каждой сохраняемой колонки названа причина в доккомментарии', () => {
      const source = readFileSync(join(__dirname, 'rights-license-snapshot.ts'), 'utf8');
      for (const preserved of PRESERVED_LICENSE_COLUMNS) {
        const doc = source.slice(0, source.indexOf('PRESERVED_LICENSE_COLUMNS ='));
        expect(doc).toContain(preserved);
      }
    });
  });

  describe('CLEAR_LICENSE_SNAPSHOT', () => {
    /**
     * `DbNull`, а не `JsonNull`: колонка должна стать тем же SQL NULL, что у никогда
     * не заполнявшихся строк, иначе «не заполняли» и «очистили» разойдутся в фильтрах по Json.
     */
    it('чистит Json-колонки DbNull, а не JsonNull', () => {
      expect(CLEAR_LICENSE_SNAPSHOT.rightsLicenseIds).toBe(Prisma.DbNull);
      expect(CLEAR_LICENSE_SNAPSHOT.rightsLicenseUncoveredCountryCodes).toBe(Prisma.DbNull);
      expect(CLEAR_LICENSE_SNAPSHOT.rightsLicenseIds).not.toBe(Prisma.JsonNull);
    });

    it('гасит дату публикации и не трогает статус: его ставит сам путь снятия', () => {
      expect(CLEAR_LICENSE_SNAPSHOT).toHaveProperty('publishedAt', null);
      expect(CLEAR_LICENSE_SNAPSHOT).not.toHaveProperty('status');
    });
  });

  describe('licenseSnapshotPayload', () => {
    it('отдаёт даты строками ISO и сохраняет Json как есть', () => {
      expect(licenseSnapshotPayload(snapshot)).toEqual({
        publishedAt: '2026-09-01T10:00:00.000Z',
        rightsLicenseIds: ['lic-A', 'lic-B'],
        rightsLicenseCoverageStatus: 'COVERED',
        rightsLicenseCheckedAt: '2026-09-01T09:59:00.000Z',
        rightsLicenseUncoveredCountryCodes: ['BR'],
      });
    });

    it('в payload идёт ровно то, что гасится', () => {
      expect(Object.keys(licenseSnapshotPayload(snapshot)).sort()).toEqual(
        Object.keys(CLEAR_LICENSE_SNAPSHOT).sort(),
      );
    });

    it('пустой снимок отдаёт полным набором ключей, а не пропускает их', () => {
      const empty: RightsLicenseSnapshot = {
        status: 'published',
        publishedAt: null,
        rightsLicenseIds: null,
        rightsLicenseCoverageStatus: null,
        rightsLicenseCheckedAt: null,
        rightsLicenseUncoveredCountryCodes: null,
      };
      // Ключ на месте с `null` внутри: пропущенный ключ в журнале неотличим
      // от «поле не гасили», а гасили его всегда.
      expect(Object.keys(licenseSnapshotPayload(empty)).sort()).toEqual(
        Object.keys(CLEAR_LICENSE_SNAPSHOT).sort(),
      );
    });
  });

  /**
   * `LEGACY-015`, решение арбитра 20.09.2026. Предикат отвечает на один вопрос: менялось ли
   * **покрытие**, а не снимок целиком. Повторная публикация переписывает `publishedAt`
   * и `rightsLicenseCheckedAt` всегда, поэтому сравнение целиком было бы истинным на каждом
   * вызове, а событие писалось бы на каждый клик.
   */
  describe('licenseSnapshotChanged', () => {
    const base: Omit<RightsLicenseSnapshot, 'status'> = {
      publishedAt: new Date('2026-09-01T10:00:00.000Z'),
      rightsLicenseIds: ['lic-A', 'lic-B'],
      rightsLicenseCoverageStatus: 'COVERED',
      rightsLicenseCheckedAt: new Date('2026-09-01T09:59:00.000Z'),
      rightsLicenseUncoveredCountryCodes: ['BR'],
    };

    it('новые даты при том же покрытии изменением не считаются', () => {
      expect(
        licenseSnapshotChanged(base, {
          ...base,
          publishedAt: new Date('2026-09-20T10:00:00.000Z'),
          rightsLicenseCheckedAt: new Date('2026-09-20T09:59:00.000Z'),
        }),
      ).toBe(false);
    });

    it('переставленный порядок идентификаторов изменением не считается', () => {
      expect(licenseSnapshotChanged(base, { ...base, rightsLicenseIds: ['lic-B', 'lic-A'] })).toBe(
        false,
      );
    });

    it('другая лицензия — изменение', () => {
      expect(licenseSnapshotChanged(base, { ...base, rightsLicenseIds: ['lic-C'] })).toBe(true);
    });

    it('тот же набор лицензий при другом статусе покрытия — изменение', () => {
      expect(
        licenseSnapshotChanged(base, { ...base, rightsLicenseCoverageStatus: 'PARTIAL' }),
      ).toBe(true);
    });

    it('другой список непокрытых стран — изменение', () => {
      expect(
        licenseSnapshotChanged(base, { ...base, rightsLicenseUncoveredCountryCodes: ['MX'] }),
      ).toBe(true);
    });

    it('null и пустой массив — разные состояния, а не одно', () => {
      // «Покрытие не считали» против «посчитали, вышло пусто»: сведи их в одно —
      // и первая публикация после расчёта, давшего пустой список, событие потеряет.
      expect(
        licenseSnapshotChanged(
          { ...base, rightsLicenseIds: null },
          { ...base, rightsLicenseIds: [] },
        ),
      ).toBe(true);
    });

    it('игнорируемые колонки перечислены явно, а не подразумеваются', () => {
      expect([...SNAPSHOT_COLUMNS_IGNORED_IN_COMPARISON].sort()).toEqual([
        'publishedAt',
        'rightsLicenseCheckedAt',
      ]);
    });
  });

  describe('lockLicenseSnapshot', () => {
    const txWith = (queryRaw: jest.Mock) =>
      ({ $queryRaw: queryRaw }) as unknown as Prisma.TransactionClient;

    it('берёт строку под замок и отдаёт её снимок вместе со статусом', async () => {
      const queryRaw = jest.fn().mockResolvedValue([snapshot]);

      const result = await lockLicenseSnapshot(txWith(queryRaw), 'v1');

      expect(result).toEqual(snapshot);
      expect(queryRaw).toHaveBeenCalledTimes(1);
      const sql = (queryRaw.mock.calls[0][0] as string[]).join('');
      expect(sql).toContain('FOR UPDATE');
      expect(sql).toContain('"BookVersion"');
      // Статус читается под тем же замком: иначе перепроверить прочитанное до замка нечем.
      expect(sql).toContain('"status"');
      // Идентификатор уходит параметром, а не склейкой в текст запроса.
      expect(queryRaw.mock.calls[0][1]).toBe('v1');
    });

    it('отдаёт null, если строки нет: версию удалили до замка', async () => {
      const queryRaw = jest.fn().mockResolvedValue([]);

      await expect(lockLicenseSnapshot(txWith(queryRaw), 'v1')).resolves.toBeNull();
    });

    it('отказ запроса пробрасывает наружу, а не глушит', async () => {
      const dbDown = new Error('db down');
      const queryRaw = jest.fn().mockRejectedValue(dbDown);

      await expect(lockLicenseSnapshot(txWith(queryRaw), 'v1')).rejects.toBe(dbDown);
    });

    /**
     * Сторож первого аргумента. `Prisma.TransactionClient` структурно принимает корневой
     * `PrismaService`, поэтому `lockLicenseSnapshot(this.prisma, id)` компилируется — а `FOR
     * UPDATE` в autocommit отпускает строку сразу после чтения, и замок пропадает молча.
     * Типом это не держится, поэтому держится разбором исходников.
     *
     * ⚠️ Предел этой проверки: она смотрит на **написание** первого аргумента, а не на то,
     * что за клиент в нём лежит. Вызов из приватного хелпера, чей параметр назван `tx`,
     * она пропустит, даже если наверх ему передали корневой клиент. Все четыре живых
     * вызова лежат внутри `$transaction`; появится пятый — проверять придётся и то,
     * откуда пришёл сам `tx`.
     */
    it('во всём src зовётся только с клиентом транзакции', () => {
      const callRe = /lockLicenseSnapshot\(\s*([A-Za-z_$][\w$.]*)/g;
      const wrong: string[] = [];

      for (const file of listFiles(
        SRC_ROOT,
        (path) => path.endsWith('.ts') && !path.endsWith('.spec.ts'),
      )) {
        const text = readFileSync(file, 'utf8');
        for (const [, firstArg] of text.matchAll(callRe)) {
          // Объявление самой функции в модуле под правило не подпадает.
          if (firstArg === 'tx' || firstArg === 'tx:') continue;
          wrong.push(`${relativeToSrc(file)}: lockLicenseSnapshot(${firstArg}, …)`);
        }
      }

      expect(wrong).toEqual([]);
    });
  });
});
