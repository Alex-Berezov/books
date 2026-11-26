import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { jsonField } from '../../shared/prisma/json-field.util';
import { geoSubjectOf } from './book-world-data';
import { runInWorldTx } from './book-world-lock';
import { BOOK_WORLD_LIMITS } from './dto/book-world-blocks.dto';
import { WikidataClient } from './wikidata.client';
import {
  checkWikidataEntity,
  geoFingerprint,
  geoInputOf,
  geoNeedsCheck,
  readGeo,
  type StoredWorldGeo,
  type WorldGeoInput,
} from './world-geo';

const GEO_ROW_SELECT = {
  key: true,
  type: true,
  name: true,
  aliases: true,
  blocks: true,
  geo: true,
  updatedAt: true,
} as const satisfies Prisma.BookWorldEntitySelect;
type GeoRow = Prisma.BookWorldEntityGetPayload<{ select: typeof GEO_ROW_SELECT }>;

function inputOf(row: GeoRow, language: string): WorldGeoInput | null {
  return geoInputOf(geoSubjectOf(row), language);
}

/** Запросов к Wikidata одновременно на одну запись мира. */
export const WORLD_GEO_PARALLEL = 4;
/**
 * Общий срок проверки точек на одну запись мира: после него новые порции не начинаются, места
 * проверятся при следующей записи. Ответ записи (уже закоммиченной) не ждёт десятков порций.
 */
export const WORLD_GEO_BUDGET_MS = 30_000;

/**
 * Проход хода «Write World» по записям (`F08-12b`, решение арбитра `F08 | F08-12b` Q3): шаг хода или
 * «Accept all». Wikidata не ответила на одной записи прохода - до конца прохода она не запрашивается
 * (иначе «Accept all» по десятку мест ждал бы срок запроса на каждом пункте). Живёт только в памяти
 * прохода, в базу не пишется; места без проверки проверятся при следующей записи (`geoNeedsCheck`, R1).
 * Ручная запись вкладки прохода не несёт - проверяет как прежде.
 */
export class WorldGeoPass {
  unavailable = false;
}

/**
 * Точка места из Wikidata (`F08-12a`, решение арбитра `F08 | F08-12` Q2). Зовётся записью мира
 * **после** её транзакции: сетевой запрос не держит замок мира и отказ Wikidata запись не валит.
 * Итог пишется под замком мира, только если вход проверки за время запроса не сменился (иначе
 * новая запись сама поставит свою проверку), и без сдвига `updatedAt`: точка — не правка сущности
 * (сверка вкладки `expectedUpdatedAt`, решение арбитра R6). Повторный запрос — только при смене
 * номера, названий, языка или после отказа Wikidata: отказ не пишется, прежний итог остаётся
 * (`geoNeedsCheck`, решение `F08 | F08-12a` R1).
 */
@Injectable()
export class WorldGeoService {
  private readonly logger = new Logger(WorldGeoService.name);
  /** Часы срока — подменяются в юнит-тесте. */
  now: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly wikidata: WikidataClient,
  ) {}

  /**
   * Проверить места `keys` версии. Число записанных строк. Не бросает никогда: запись мира к этому
   * моменту уже закоммичена, и отказ Wikidata или замка не должен превращать её ответ в ошибку —
   * непроверенное место проверится при следующей записи (`geoNeedsCheck`).
   */
  async refresh(
    bookVersionId: string,
    language: string,
    keys: readonly string[],
    pass: WorldGeoPass | null = null,
  ): Promise<number> {
    if (keys.length === 0) return 0;
    try {
      return await this.refreshRows(bookVersionId, language, keys, pass);
    } catch (error) {
      this.logger.warn(
        `geo refresh ${bookVersionId}: ${error instanceof Error ? error.message : 'error'}`,
      );
      return 0;
    }
  }

  private async refreshRows(
    bookVersionId: string,
    language: string,
    keys: readonly string[],
    pass: WorldGeoPass | null,
  ): Promise<number> {
    // Без отбора по типу: строка, переставшая быть местом, тоже снимает свою проверку.
    const rows = await this.prisma.bookWorldEntity.findMany({
      where: { bookVersionId, key: { in: [...new Set(keys)] } },
      select: GEO_ROW_SELECT,
      orderBy: { key: 'asc' },
      take: BOOK_WORLD_LIMITS.entities,
    });
    const jobs = rows.flatMap((row): { key: string; input: WorldGeoInput | null }[] => {
      const input = inputOf(row, language);
      if (!input) return row.geo !== null ? [{ key: row.key, input: null }] : [];
      return geoNeedsCheck(readGeo(row.geo), input) ? [{ key: row.key, input }] : [];
    });
    let written = 0;
    // Снятие прежней проверки сети не требует — идёт всегда, до запросов и вне срока.
    for (const job of jobs.filter((j) => j.input === null)) {
      if ((await this.checkOne(bookVersionId, language, job.key, null)).written) written++;
    }
    // Порциями по `WORLD_GEO_PARALLEL` в пределах `WORLD_GEO_BUDGET_MS`: запрос записи не ждёт
    // сотню запросов подряд. Wikidata не ответила в порции — новых запросов в этой записи нет.
    // Проход хода уже видел отказ Wikidata (Q3): запросов в нём больше нет.
    const checks = pass?.unavailable ? [] : jobs.filter((j) => j.input !== null);
    const deadline = this.now() + WORLD_GEO_BUDGET_MS;
    for (let at = 0; at < checks.length && this.now() < deadline; at += WORLD_GEO_PARALLEL) {
      const batch = checks.slice(at, at + WORLD_GEO_PARALLEL);
      const results = await Promise.all(
        batch.map((job) => this.checkOne(bookVersionId, language, job.key, job.input)),
      );
      written += results.filter((r) => r.written).length;
      if (results.some((r) => r.unavailable)) {
        if (pass) pass.unavailable = true;
        break;
      }
    }
    return written;
  }

  /** Одно место: запрос (если вход есть) и запись итога; отказ записи — в журнал, не наружу. */
  private async checkOne(
    bookVersionId: string,
    language: string,
    key: string,
    input: WorldGeoInput | null,
  ): Promise<{ written: boolean; unavailable: boolean }> {
    let geo: StoredWorldGeo | null = null;
    if (input) {
      const result = await this.wikidata.entity(input.wikidataId);
      const check =
        result.kind === 'ok'
          ? checkWikidataEntity(result.body, input)
          : { point: null, reason: result.kind };
      // Wikidata не ответила — проверки не было: прежний итог не перезаписывается (проверенная
      // точка не стирается сбоем сети), а читателю её не отдаёт `publicPoint`, пока вход другой.
      // Следующая запись проверит снова (`geoNeedsCheck`).
      if (check.reason === 'unavailable') return { written: false, unavailable: true };
      geo = {
        wikidataId: input.wikidataId,
        checkedFor: geoFingerprint(input),
        language: input.language,
        checkedAt: new Date().toISOString(),
        ...check,
      };
    }
    try {
      const fingerprint = input ? geoFingerprint(input) : null;
      return {
        written: await this.write(bookVersionId, key, language, fingerprint, geo),
        unavailable: false,
      };
    } catch (error) {
      this.logger.warn(
        `geo write ${bookVersionId}/${key}: ${error instanceof Error ? error.message : 'error'}`,
      );
      return { written: false, unavailable: false };
    }
  }

  /**
   * Итог под замком мира: вход проверки строки сейчас тот же, для которого шёл запрос
   * (`fingerprint`; `null` — входа нет). Иначе ничего не пишется.
   */
  private write(
    bookVersionId: string,
    key: string,
    language: string,
    fingerprint: string | null,
    geo: StoredWorldGeo | null,
  ): Promise<boolean> {
    return runInWorldTx(this.prisma, bookVersionId, async (tx) => {
      const current = await tx.bookWorldEntity.findUnique({
        where: { bookVersionId_key: { bookVersionId, key } },
        select: GEO_ROW_SELECT,
      });
      if (!current) return false;
      // Не место — входа нет (`geoInputOf`): снимается только прежняя проверка (`fingerprint` null).
      const now = inputOf(current, language);
      if ((now ? geoFingerprint(now) : null) !== fingerprint) return false;
      await tx.bookWorldEntity.update({
        where: { bookVersionId_key: { bookVersionId, key } },
        data: { ...jsonField('geo', geo), updatedAt: current.updatedAt },
      });
      return true;
    });
  }
}
