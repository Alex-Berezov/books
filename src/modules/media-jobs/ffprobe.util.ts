import { path as ffprobePath } from '@ffprobe-installer/ffprobe';
import { spawn } from 'node:child_process';

export interface ProbeResult {
  durationSec: number | null;
}

/**
 * Протоколы и демультиплексоры, которые ffprobe вправе открыть (`LEGACY-461`). Вход — файл
 * на диске или публичный адрес нашего хранилища, и протоколы берутся по виду входа: файлу — только
 * `file`, адресу — только сетевые, чтобы редирект хранилища на `file://` не открыл локальный файл.
 * Плейлисты (`hls`, `concat`) и прочие демультиплексоры, умеющие сами ходить по адресам
 * из содержимого, не пускаются: загруженный под `audio/*` плейлист увёл бы пробу на внутренние
 * адреса. Список демультиплексоров — по разрешённым типам аудио (`UPLOADS_ALLOWED_AUDIO_CT`):
 * mp3, mp4/m4a, aac, ogg, wav, webm.
 */
const FFPROBE_FILE_PROTOCOLS = 'file';
const FFPROBE_URL_PROTOCOLS = 'http,https,tcp,tls';
const FFPROBE_FORMAT_WHITELIST = 'mp3,mov,aac,ogg,wav,matroska';

/** Потолок на весь процесс ffprobe и на одно сетевое чтение: зависший источник не держит очередь. */
const FFPROBE_TIMEOUT_MS = 60_000;
const FFPROBE_RW_TIMEOUT_US = 15_000_000;

/** Вход пробы — сетевой адрес (`http`/`https`), а не файл на диске. Одно правило на сервис и аргументы. */
export function isRemoteProbeInput(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

/**
 * Аргументы ffprobe для пробы длительности — одно место для боевого запуска и для спеки,
 * которая гоняет настоящий бинарь по каждому разрешённому типу аудио.
 */
export function ffprobeArgs(input: string): string[] {
  return [
    '-v',
    'error',
    '-protocol_whitelist',
    isRemoteProbeInput(input) ? FFPROBE_URL_PROTOCOLS : FFPROBE_FILE_PROTOCOLS,
    '-format_whitelist',
    FFPROBE_FORMAT_WHITELIST,
    '-rw_timeout',
    String(FFPROBE_RW_TIMEOUT_US),
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    input,
  ];
}

/**
 * Probe an audio/video file to extract its duration.
 * Returns { durationSec: null } on any failure, timeout or unparseable output.
 */
export async function probeDuration(filePath: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const args = ffprobeArgs(filePath);
    let out = '';
    const child = spawn(ffprobePath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), FFPROBE_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ durationSec: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ durationSec: null });
      const parsed = Number.parseFloat(out.trim());
      if (!Number.isFinite(parsed) || parsed < 0) return resolve({ durationSec: null });
      resolve({ durationSec: Math.round(parsed) });
    });
  });
}
