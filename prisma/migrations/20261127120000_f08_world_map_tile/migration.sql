-- `F08-12d`: кэш тайлов подложки литературной карты (решения арбитра `F08 | F08-12d`). Тайл качается
-- только при запросе страницы с картой и хранится по версионному ключу; срок и ETag - для ревалидации.
--
-- Миграция только добавляющая: новая таблица, прежние не трогаются. Прежний образ таблицу не читает.
-- Идемпотентна (`IF NOT EXISTS`), как `20261126120000_f08_world_image_entity_type`.
CREATE TABLE IF NOT EXISTS "WorldMapTile" (
    "z" INTEGER NOT NULL,
    "x" INTEGER NOT NULL,
    "y" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "prevStorageKey" TEXT,
    "etag" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorldMapTile_pkey" PRIMARY KEY ("z","x","y")
);
