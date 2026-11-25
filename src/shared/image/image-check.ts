/**
 * Проверка картинки (`F08-11a`, решение арбитра `F08 | F08-11` Р1): файл - чужие байты, поэтому
 * тип - только по сигнатуре, размеры - из заголовка, без разбора файла целиком и без внешних
 * зависимостей. Заявленный тип не читается: SVG с `image/png` в заголовке - XSS с медиа-хоста.
 * Перенесена из модуля LLM в `shared/` (`F08-11d-3`): генерации моделью нет, проверка служит загрузке файла.
 */

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface ImageInfo {
  mime: ImageMime;
  ext: 'png' | 'jpg' | 'webp';
  width: number;
  height: number;
}

/**
 * Причина отказа картинки - без домена: код ответа ручки называет её потребитель
 * (иллюстрация героя - `WORLD_IMAGE_REFUSAL_CODES`).
 */
export const IMAGE_NOT_IMAGE = 'NOT_IMAGE';
export const IMAGE_TOO_LARGE = 'TOO_LARGE';
export const IMAGE_TOO_SMALL = 'TOO_SMALL';
export type ImageRefusal = typeof IMAGE_NOT_IMAGE | typeof IMAGE_TOO_LARGE | typeof IMAGE_TOO_SMALL;

export interface ImageLimits {
  /** Наибольший файл после декодирования, байт. */
  maxBytes: number;
  /** Наименьшая ширина, px (`product.md` §8: исходник от 1200 px). */
  minWidth: number;
  /** Наименьшая высота, px: модель, не послушавшая пропорции, не даёт полосу вместо портрета. */
  minHeight: number;
  /** Наибольшее число пикселей: заголовок с огромными размерами - отказ до любой обработки. */
  maxPixels: number;
}

export type ImageCheck =
  | { ok: true; bytes: Buffer; info: ImageInfo }
  | { ok: false; reason: ImageRefusal };

/** Байты -> проверенная картинка: размер файла, тип по сигнатуре, пиксели, наименьшие стороны. */
export function checkImageBytes(bytes: Buffer, limits: ImageLimits): ImageCheck {
  if (bytes.length > limits.maxBytes) return refuse(IMAGE_TOO_LARGE);
  const info = sniffImage(bytes);
  if (!info) return refuse(IMAGE_NOT_IMAGE);
  if (info.width * info.height > limits.maxPixels) return refuse(IMAGE_TOO_LARGE);
  if (info.width < limits.minWidth || info.height < limits.minHeight) {
    return refuse(IMAGE_TOO_SMALL);
  }
  return { ok: true, bytes, info };
}

function refuse(reason: ImageRefusal): ImageCheck {
  return { ok: false, reason };
}

/** Тип и размеры по сигнатуре; `null` - не PNG, не JPEG и не WEBP (SVG, GIF, HTML - сюда же). */
export function sniffImage(bytes: Buffer): ImageInfo | null {
  return png(bytes) ?? jpeg(bytes) ?? webp(bytes);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG: сигнатура, первый чанк - `IHDR`, ширина и высота - его первые 8 байт. */
function png(b: Buffer): ImageInfo | null {
  if (b.length < 24 || !b.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return sized('image/png', 'png', b.readUInt32BE(16), b.readUInt32BE(20));
}

/**
 * JPEG: `FFD8`, дальше сегменты до первого SOF (`C0`-`CF`, кроме `C4` DHT, `C8` JPG, `CC` DAC):
 * высота и ширина - в нём. Длина сегмента ведёт по файлу, разбор не уходит за конец буфера.
 */
function jpeg(b: Buffer): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xff) {
      at += 1; // заполнитель
      continue;
    }
    // Маркеры без длины: RST0-7, SOI, TEM.
    if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // конец или данные без SOF
    const length = b.readUInt16BE(at + 2);
    if (length < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) {
      if (at + 9 > b.length) return null;
      return sized('image/jpeg', 'jpg', b.readUInt16BE(at + 7), b.readUInt16BE(at + 5));
    }
    at += 2 + length;
  }
  return null;
}

/** WEBP: `RIFF....WEBP` и чанк `VP8 ` (с потерями), `VP8L` (без потерь) или `VP8X` (расширенный). */
function webp(b: Buffer): ImageInfo | null {
  if (b.length < 30) return null;
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    // Кадр: 3 байта тега, стартовый код 9D 01 2A, затем 14 бит ширины и высоты.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return sized('image/webp', 'webp', b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return sized('image/webp', 'webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8X') {
    return sized('image/webp', 'webp', b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1);
  }
  return null;
}

function sized(
  mime: ImageMime,
  ext: ImageInfo['ext'],
  width: number,
  height: number,
): ImageInfo | null {
  if (!(width > 0 && height > 0)) return null;
  return { mime, ext, width, height };
}
