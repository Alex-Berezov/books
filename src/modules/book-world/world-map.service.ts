import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_SERVICE, StorageService } from '../../shared/storage/storage.interface';
import { sniffImage } from '../../shared/image/image-check';
import { OsmTileClient } from './osm-tile.client';
import {
  bookMapLayout,
  placeMapLayout,
  type WorldMapLayout,
  type WorldMapPointInput,
  type WorldMapTileRef,
} from './world-map';
import type { BookWorldMapDto } from './dto/book-world-response.dto';

/** Наименьший срок хранения тайла - политика OSM: заголовки сервера, но не меньше 7 дней. */
export const WORLD_MAP_MIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Устаревший тайл при отказе ревалидации отдаётся не дольше 30 дней после срока (Р6). */
export const WORLD_MAP_STALE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
/** Прерыватель (Р6): после отказа OSM 5 минут не спрашиваем, работаем только из хранилища. */
export const WORLD_MAP_BREAKER_MS = 5 * 60 * 1000;

const TILE_KEY_PREFIX = 'world-map/osm';

type TileRow = {
  z: number;
  x: number;
  y: number;
  storageKey: string;
  prevStorageKey: string | null;
  etag: string | null;
  expiresAt: Date;
};
const TILE_ROW_SELECT = {
  z: true,
  x: true,
  y: true,
  storageKey: true,
  prevStorageKey: true,
  etag: true,
  expiresAt: true,
} as const;

/** Часы сервиса: тесты и e2e двигают время, не трогая таймеры `fetch` (транспорт - как у клиента). */
export type WorldMapClock = () => number;
const WORLD_MAP_CLOCK = Symbol('WORLD_MAP_CLOCK');

const tileId = (t: { z: number; x: number; y: number }) => `${t.z}/${t.x}/${t.y}`;

/**
 * Литературная карта (`F08-12d`, решения арбитра `F08 | F08-12d`): тайлы OSM берутся только при
 * запросе страницы с картой (общая карта - `?map=1` списка, малая - страница реального места),
 * кладутся в хранилище по версионному ключу (у `image/*` в R2 `immutable` на год, поэтому новое
 * содержимое - новый ключ) и хранятся по сроку сервера, не меньше 7 дней; после срока - условный
 * запрос по ETag. Прежний объект тайла после смены содержимого **не удаляется** (решение `F08 | F08-12d`
 * круг 3 Q2): тайлы общие для книг, и страница другой книги в ISR фронта может ссылаться на него
 * сколько угодно долго; сирота - не больше одного PNG на тайл за смену, смена не чаще раза в 7 дней.
 * Строки читаются одним запросом на карту; запись - условная (`createMany` без дублей, `updateMany`
 * по прежнему ключу): проигравший гонку берёт строку победителя. Объекты хранилища сервис не удаляет
 * никогда (решение круг 4): ключ - хеш содержимого, «свой» объект может быть чужим. Тайлы карты
 * качаются параллельно (до 12), срок карты - таймаут тайла клиента (3 с). Нет хоть одного тайла -
 * карты нет целиком (`null`), запрос страницы от этого не падает.
 */
@Injectable()
export class WorldMapService {
  private readonly logger = new Logger(WorldMapService.name);
  /** До какого момента OSM не спрашивают (прерыватель на процесс). */
  private breakerUntil = 0;
  private readonly now: WorldMapClock;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly client: OsmTileClient,
    @Optional() @Inject(WORLD_MAP_CLOCK) clock?: WorldMapClock,
  ) {
    this.now = clock ?? (() => Date.now());
  }

  /** Общая карта книги: тайлы берутся сейчас, если их нет в хранилище; точек нет - `null`. */
  buildBookMap(points: readonly WorldMapPointInput[]): Promise<BookWorldMapDto | null> {
    const layout = bookMapLayout(points);
    return layout ? this.render(layout) : Promise.resolve(null);
  }

  /** Малая карта места: 4 тайла z=12, берутся сейчас, если их нет в хранилище. */
  buildPlaceMap(point: WorldMapPointInput): Promise<BookWorldMapDto | null> {
    return this.render(placeMapLayout(point));
  }

  private async render(layout: WorldMapLayout): Promise<BookWorldMapDto | null> {
    try {
      const rows = await this.prisma.worldMapTile.findMany({
        where: { OR: layout.tiles.map((t) => ({ z: t.z, x: t.x, y: t.y })) },
        select: TILE_ROW_SELECT,
        take: layout.tiles.length,
      });
      const byId = new Map(rows.map((r) => [tileId(r), r]));
      // Тайлы - параллельно, в потолке 12 (решение «механизм тайлов»): срок карты - таймаут тайла.
      const urls = await Promise.all(
        layout.tiles.map((t) => this.tileUrl(t, byId.get(tileId(t)) ?? null)),
      );
      if (urls.some((u) => u === null)) return null;
      return {
        zoom: layout.zoom,
        cols: layout.cols,
        rows: layout.rows,
        tiles: layout.tiles.map((t, i) => ({ col: t.col, row: t.row, url: urls[i]! })),
        points: layout.points,
      };
    } catch (error) {
      // Таблицы ещё нет (миграция не применена) или хранилище не ответило: страница без карты.
      this.logger.warn(`World map: ${error instanceof Error ? error.message : 'error'}`);
      return null;
    }
  }

  /** Адрес тайла в хранилище или `null`, если тайла нет и взять его сейчас нельзя. */
  private async tileUrl(t: WorldMapTileRef, row: TileRow | null): Promise<string | null> {
    const now = this.now();
    if (row && row.expiresAt.getTime() > now) return this.storage.getPublicUrl(row.storageKey);
    const stale = () =>
      row && now < row.expiresAt.getTime() + WORLD_MAP_STALE_GRACE_MS
        ? this.storage.getPublicUrl(row.storageKey)
        : null;
    if (now < this.breakerUntil) return stale();

    const result = await this.client.tile(t.z, t.x, t.y, row?.etag ?? null);
    if (result.kind === 'unavailable') {
      if (result.trip) this.breakerUntil = this.now() + WORLD_MAP_BREAKER_MS;
      return stale();
    }
    const expiresAt = new Date(now + ttlMs(result.maxAgeSec));
    const fetchedAt = new Date(now);
    const at = { z: t.z, x: t.x, y: t.y };
    if (result.kind === 'not_modified') {
      if (!row) return null;
      // Срок продлевается только той строке, которую ревалидировали; чужая смена не затирается.
      await this.prisma.worldMapTile.updateMany({
        where: { ...at, storageKey: row.storageKey },
        data: { expiresAt, fetchedAt },
      });
      return this.storage.getPublicUrl(row.storageKey);
    }
    const info = sniffImage(result.bytes);
    if (info?.mime !== 'image/png') return stale();
    const hash = createHash('sha256').update(result.bytes).digest('hex').slice(0, 16);
    const storageKey = `${TILE_KEY_PREFIX}/${t.z}/${t.x}/${t.y}/${hash}.png`;
    const meta = { etag: result.etag, expiresAt, fetchedAt };

    if (row?.storageKey === storageKey) {
      // Содержимое то же (сервер ответил 200 без ETag): объект уже есть, продлевается срок.
      await this.prisma.worldMapTile.updateMany({
        where: { ...at, storageKey },
        data: meta,
      });
      return this.storage.getPublicUrl(storageKey);
    }
    await this.storage.save(storageKey, result.bytes, { contentType: 'image/png' });
    return this.claim(at, row, storageKey, meta);
  }

  /**
   * Условная запись строки после того, как новый объект лёг в хранилище: победитель гонки - строка
   * с новым ключом; проигравший отдаёт строку победителя. Свой объект не удаляется ни при отказе
   * записи, ни при проигранной гонке: с тем же ключом его могла записать соседняя строка.
   */
  private async claim(
    at: { z: number; x: number; y: number },
    row: TileRow | null,
    storageKey: string,
    meta: { etag: string | null; expiresAt: Date; fetchedAt: Date },
  ): Promise<string | null> {
    const won = row
      ? (
          await this.prisma.worldMapTile.updateMany({
            where: { ...at, storageKey: row.storageKey },
            data: { ...meta, storageKey, prevStorageKey: row.storageKey },
          })
        ).count === 1
      : (
          await this.prisma.worldMapTile.createMany({
            data: [{ ...at, ...meta, storageKey, prevStorageKey: null }],
            skipDuplicates: true,
          })
        ).count === 1;
    // Прежние объекты не удаляются: на них могут ссылаться страницы любой книги в ISR (круг 3 Q2).
    if (won) return this.storage.getPublicUrl(storageKey);
    // Гонку выиграл другой запрос: его строка - правда.
    const current = await this.prisma.worldMapTile.findUnique({
      where: { z_x_y: at },
      select: { storageKey: true },
    });
    return current ? this.storage.getPublicUrl(current.storageKey) : null;
  }
}

/** Срок хранения: заголовок сервера, но не меньше 7 дней. */
export function ttlMs(maxAgeSec: number | null): number {
  return Math.max(WORLD_MAP_MIN_TTL_MS, (maxAgeSec ?? 0) * 1000);
}
