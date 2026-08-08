-- История слагов публичных сущностей (LEGACY-062).
--
-- Слаг таксономии — индексируемый публичный URL, но `update()` перезаписывал его на
-- месте: прошлое значение исчезало без следа, старый адрес начинал отдавать 404, и
-- накопленные поисковые сигналы никуда не переносились.
--
-- ⚠️ Таблица останавливает дальнейшие потери и **не возвращает уже утраченные**:
-- записи о прошлых переименованиях нет нигде, восстановить их можно только из
-- внешних источников (GSC, логи доступа, веб-архивы).

CREATE TABLE "SlugRedirect" (
  "id"         TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "language"   "Language" NOT NULL,
  "oldSlug"    TEXT NOT NULL,
  "newSlug"    TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SlugRedirect_pkey" PRIMARY KEY ("id")
);

-- Один старый адрес ведёт ровно в одно место. Уникальность здесь — не гигиена:
-- две записи на один `oldSlug` означали бы недетерминированный редирект.
CREATE UNIQUE INDEX "SlugRedirect_entityType_language_oldSlug_key"
  ON "SlugRedirect" ("entityType", "language", "oldSlug");

-- Нужен при схлопывании цепочек: смена B→C переписывает все записи, ведущие на B.
CREATE INDEX "SlugRedirect_entityType_language_newSlug_idx"
  ON "SlugRedirect" ("entityType", "language", "newSlug");
