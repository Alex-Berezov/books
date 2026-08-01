/**
 * Отдельный токен драйвера хранилища прав: `STORAGE_SERVICE` указывает на публичное
 * хранилище медиа, и путать их нельзя — юридические файлы обязаны лежать вне того,
 * что раздаётся статикой или CDN.
 */
export const RIGHTS_FILE_STORAGE_DRIVER = Symbol('RIGHTS_FILE_STORAGE_DRIVER');
