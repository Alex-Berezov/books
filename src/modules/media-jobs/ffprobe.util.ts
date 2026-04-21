import { path as ffprobePath } from '@ffprobe-installer/ffprobe';
import { spawn } from 'node:child_process';

export interface ProbeResult {
  durationSec: number | null;
}

/**
 * Probe an audio/video file to extract its duration.
 * Returns { durationSec: null } on any failure or unparseable output.
 */
export async function probeDuration(filePath: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const args = [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ];
    let out = '';
    const child = spawn(ffprobePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', () => resolve({ durationSec: null }));
    child.on('close', (code) => {
      if (code !== 0) return resolve({ durationSec: null });
      const parsed = Number.parseFloat(out.trim());
      if (!Number.isFinite(parsed) || parsed < 0) return resolve({ durationSec: null });
      resolve({ durationSec: Math.round(parsed) });
    });
  });
}
