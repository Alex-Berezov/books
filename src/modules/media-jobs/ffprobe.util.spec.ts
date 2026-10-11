import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { path as ffprobePath } from '@ffprobe-installer/ffprobe';
import { ffprobeArgs, probeDuration } from './ffprobe.util';

/** Двухсекундный WAV: 8 кГц, моно, 16 бит, тишина. */
function silentWav(seconds: number): Buffer {
  const rate = 8000;
  const samples = rate * seconds;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  return buf;
}

/**
 * Настоящий ffprobe (`@ffprobe-installer/ffprobe`), без моков: проверяется то, что он сделает
 * с входом, а не то, какие флаги ему переданы (`LEGACY-461`).
 */
describe('probeDuration (real ffprobe)', () => {
  let dir: string;
  let server: Server;
  let hits: string[];
  let origin: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ffprobe-spec-'));
    hits = [];
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/upload.mp3') {
        // Плейлист, загруженный под видом аудио: сегмент указывает на «внутренний» адрес.
        res.setHeader('Content-Type', 'audio/mpeg');
        res.end(
          [
            '#EXTM3U',
            '#EXT-X-TARGETDURATION:10',
            '#EXTINF:10,',
            `${origin}/internal/secret.ts`,
            '#EXT-X-ENDLIST',
            '',
          ].join('\n'),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    hits.length = 0;
  });

  it('reads the duration of an allowed audio format', async () => {
    const file = join(dir, 'a.wav');
    writeFileSync(file, silentWav(2));
    await expect(probeDuration(file)).resolves.toEqual({ durationSec: 2 });
  });

  it('does not follow a playlist served from storage: only the upload itself is requested', async () => {
    await expect(probeDuration(`${origin}/upload.mp3`)).resolves.toEqual({ durationSec: null });
    expect(hits).toEqual(['/upload.mp3']);
  });

  /**
   * Белый список демультиплексоров не должен отрезать ни один разрешённый тип аудио
   * (`UPLOADS_ALLOWED_AUDIO_CT`): иначе у законных загрузок молча пропадает длительность.
   * Файлы — минимальные заголовки, по которым ffprobe узнаёт формат; часть из них дальше
   * заголовка не разбирается, и это не важно: проверяется, что отказа «не в белом списке» нет.
   */
  const box = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length);
    head.write(type, 4);
    return Buffer.concat([head, body]);
  };
  const mp3Frame = Buffer.alloc(417);
  Buffer.from([0xff, 0xfb, 0x90, 0x64]).copy(mp3Frame);
  const adts = Buffer.alloc(64);
  Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x08, 0x1f, 0xfc]).copy(adts);
  const ogg = Buffer.alloc(64);
  ogg.write('OggS');

  it.each<[string, () => Buffer]>([
    ['audio/mpeg (mp3)', () => Buffer.concat(Array<Buffer>(20).fill(mp3Frame))],
    ['audio/aac (adts)', () => Buffer.concat(Array<Buffer>(20).fill(adts))],
    [
      'audio/mp4, audio/x-m4a (mov)',
      () =>
        Buffer.concat([
          box('ftyp', Buffer.from('M4A \0\0\0\0M4A isom', 'latin1')),
          box('moov', Buffer.alloc(0)),
        ]),
    ],
    ['audio/ogg (ogg)', () => ogg],
    [
      'audio/webm (matroska)',
      () => Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]),
    ],
    ['audio/wav (wav)', () => silentWav(1)],
  ])('%s passes the format whitelist', (name, content) => {
    const file = join(dir, `type-${name.replace(/\W+/g, '-')}`);
    writeFileSync(file, content());
    const res = spawnSync(ffprobePath, ffprobeArgs(file), { encoding: 'utf8' });
    expect(res.stderr).not.toMatch(/not on whitelist/);
  });

  it('a playlist is refused by the format whitelist', () => {
    const file = join(dir, 'list.mp3');
    writeFileSync(
      file,
      [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:10',
        '#EXTINF:10,',
        'http://127.0.0.1:9/x.ts',
        '#EXT-X-ENDLIST',
        '',
      ].join('\n'),
    );
    const res = spawnSync(ffprobePath, ffprobeArgs(file), { encoding: 'utf8' });
    expect(res.stderr).toMatch(/Format not on whitelist/);
  });

  it('a remote probe may not open local files; a local probe may not go to the network', () => {
    expect(ffprobeArgs('https://media.example.com/a.mp3')).toContain('http,https,tcp,tls');
    expect(ffprobeArgs('https://media.example.com/a.mp3')).not.toContain('file');
    expect(ffprobeArgs(join(dir, 'a.mp3'))).toContain('file');
    expect(ffprobeArgs(join(dir, 'a.mp3')).join(' ')).not.toMatch(/https?/);
  });
});
