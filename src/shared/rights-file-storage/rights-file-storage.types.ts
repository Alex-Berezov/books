/**
 * WP-9 (R4-02, R3-08, R3-05): типы приватного файлового хранилища системы прав.
 *
 * Юридические файлы — отчёт агента, файл исходного издания, архивная копия доказательства —
 * намеренно не идут ни через `MediaAsset`, ни через общий модуль загрузок:
 *
 * 1. `POST /admin/media/cleanup-orphans` считает orphan'ом любой ассет без связей из
 *    `AudioChapter` / `BookVersion.previewMediaId` и снёс бы юридический след молча —
 *    прямое нарушение ADR-009;
 * 2. общее хранилище отдаётся публично (`ServeStaticModule` в local-режиме, CDN в R2), а
 *    принятый в ADR-012 пункт 11 риск утёкшей ссылки касался обложек и аудио, но не отчётов
 *    о правах.
 */

/** Вид юридического файла. Определяет префикс ключа и список разрешённых MIME-типов. */
export type RightsFileKind =
  | 'report-pdf'
  | 'report-json'
  | 'report-markdown'
  | 'raw-agent-output'
  | 'input-manifest'
  | 'source-file'
  | 'evidence';

/** То, что после сохранения попадает в колонки `*_storage_key` / `*_sha256`. */
export interface StoredRightsFile {
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  fileName: string | null;
}

/** Загружаемый человеком файл: буфер уже прочитан контроллером через multipart. */
export interface RightsFileUpload {
  buffer: Buffer;
  contentType: string;
  fileName?: string | null;
}
