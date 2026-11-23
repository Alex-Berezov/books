import {
  checkImageBase64,
  IMAGE_NOT_IMAGE,
  IMAGE_TOO_LARGE,
  IMAGE_TOO_SMALL,
  LlmImageLimits,
  sniffImage,
} from './llm-image';

const LIMITS: LlmImageLimits = {
  maxBytes: 4096,
  minWidth: 1200,
  minHeight: 1200,
  maxPixels: 40_000_000,
};

/** Заголовок PNG: сигнатура и `IHDR` с размерами; тело картинки проверке не нужно. */
function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** JPEG: SOI, сегмент APP0, затем SOF0 с высотой и шириной. */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14)]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function webpVp8x(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

function webpVp8(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write('VP8 ', 12, 'latin1');
  b[23] = 0x9d;
  b[24] = 0x01;
  b[25] = 0x2a;
  b.writeUInt16LE(width, 26);
  b.writeUInt16LE(height, 28);
  return b;
}

function webpVp8l(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  b.write('VP8L', 12, 'latin1');
  b[20] = 0x2f;
  b.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21);
  return b;
}

const b64 = (b: Buffer) => b.toString('base64');

describe('sniffImage (F08-11a, решение арбитра F08 | F08-11 Р1)', () => {
  it.each([
    ['png', png(1536, 1024), 'image/png', 1536, 1024],
    ['jpeg', jpeg(1600, 900), 'image/jpeg', 1600, 900],
    ['webp VP8X', webpVp8x(2048, 2048), 'image/webp', 2048, 2048],
    ['webp VP8', webpVp8(1300, 1300), 'image/webp', 1300, 1300],
    ['webp VP8L', webpVp8l(1400, 1200), 'image/webp', 1400, 1200],
  ])('%s: type by signature, size from the header', (_, bytes, mime, width, height) => {
    expect(sniffImage(bytes)).toMatchObject({ mime, width, height });
  });

  it.each([
    ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2000"></svg>')],
    ['gif', Buffer.from('GIF89a\xd0\x07\xd0\x07', 'latin1')],
    ['html', Buffer.from('<html><script>alert(1)</script></html>')],
    ['truncated png', png(1500, 1500).subarray(0, 20)],
    ['jpeg without SOF', Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
    ['png with zero width', png(0, 1500)],
  ])('%s is not an image', (_, bytes) => {
    expect(sniffImage(bytes)).toBeNull();
  });
});

describe('checkImageBase64', () => {
  it('accepts an image at least 1200 px wide', () => {
    const result = checkImageBase64(b64(png(1200, 1200)), LIMITS);
    expect(result).toMatchObject({ ok: true, info: { mime: 'image/png', ext: 'png' } });
  });

  it('refuses a narrower image', () => {
    expect(checkImageBase64(b64(png(1024, 1024)), LIMITS)).toEqual({
      ok: false,
      reason: IMAGE_TOO_SMALL,
    });
  });

  it('refuses a strip that ignored the aspect ratio (2048 x 300)', () => {
    expect(checkImageBase64(b64(png(2048, 300)), LIMITS)).toEqual({
      ok: false,
      reason: IMAGE_TOO_SMALL,
    });
  });

  it('refuses an SVG whatever the provider claims', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    expect(checkImageBase64(b64(svg), LIMITS)).toEqual({ ok: false, reason: IMAGE_NOT_IMAGE });
  });

  it('refuses a string over the limit before decoding it', () => {
    const from = jest.spyOn(Buffer, 'from');
    const huge = 'A'.repeat(Math.ceil(LIMITS.maxBytes / 3) * 4 + 4);
    expect(checkImageBase64(huge, LIMITS)).toEqual({ ok: false, reason: IMAGE_TOO_LARGE });
    expect(from).not.toHaveBeenCalled();
    from.mockRestore();
  });

  it('refuses a header with more pixels than the ceiling', () => {
    expect(checkImageBase64(b64(png(20_000, 20_000)), LIMITS)).toEqual({
      ok: false,
      reason: IMAGE_TOO_LARGE,
    });
  });

  it.each([
    ['not a string', null],
    ['empty', ''],
    ['not base64', '%%%%'],
    ['a data URL', `data:image/png;base64,${b64(png(1500, 1500))}`],
  ])('%s is not an image', (_, value) => {
    expect(checkImageBase64(value, LIMITS)).toEqual({ ok: false, reason: IMAGE_NOT_IMAGE });
  });
});
