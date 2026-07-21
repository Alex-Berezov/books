import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_SERVICE, StorageService } from '../../shared/storage/storage.interface';
import { probeDuration } from './ffprobe.util';

export const MEDIA_PROBE_QUEUE = Symbol('MEDIA_PROBE_QUEUE');
export const MEDIA_PROBE_WORKER = Symbol('MEDIA_PROBE_WORKER');

export interface MediaProbeJobData {
  mediaId: string;
}

export interface MediaProbeJobResult {
  mediaId: string;
  durationSec: number | null;
}

@Injectable()
export class MediaProbeService {
  private readonly logger = new Logger(MediaProbeService.name);
  private probeJobsCompleted = 0;
  private probeJobsFailed = 0;
  private probeJobsSkipped = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Optional() @Inject(MEDIA_PROBE_QUEUE) private readonly queue?: Queue,
  ) {}

  /**
   * Enqueue a probe job. If queue is unavailable (no Redis), falls back to
   * synchronous probe so that metadata is still populated in dev/test.
   */
  async enqueueProbe(mediaId: string): Promise<void> {
    if (!this.queue) {
      this.logger.debug(`Probe queue unavailable, running inline for ${mediaId}`);
      await this.runProbe(mediaId);
      return;
    }
    await this.queue.add('probe', { mediaId } satisfies MediaProbeJobData, {
      attempts: Number(this.config.get('MEDIA_PROBE_ATTEMPTS') ?? 3),
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 500,
    });
  }

  /** Reprobe all audio media assets with null duration. Returns count enqueued. */
  async reprobeAll(): Promise<{ enqueued: number }> {
    const assets = await this.prisma.mediaAsset.findMany({
      where: {
        isDeleted: false,
        duration: null,
        contentType: { startsWith: 'audio/' },
      },
      select: { id: true },
    });
    for (const a of assets) {
      await this.enqueueProbe(a.id);
    }
    return { enqueued: assets.length };
  }

  /**
   * Actual probe execution. Reads the local file and writes duration.
   * Idempotent: if duration already set, skips.
   */
  async runProbe(mediaId: string): Promise<MediaProbeJobResult> {
    const asset = await this.prisma.mediaAsset.findUnique({
      where: { id: mediaId },
      select: {
        id: true,
        key: true,
        url: true,
        contentType: true,
        duration: true,
        isDeleted: true,
      },
    });
    if (!asset || asset.isDeleted) {
      this.probeJobsSkipped += 1;
      return { mediaId, durationSec: null };
    }
    if (asset.duration != null) {
      this.probeJobsSkipped += 1;
      return { mediaId, durationSec: asset.duration };
    }
    if (!asset.contentType || !asset.contentType.startsWith('audio/')) {
      this.probeJobsSkipped += 1;
      return { mediaId, durationSec: null };
    }
    const storage = this.storage;
    let probeInput: string | null = null;
    if (typeof storage.getLocalPath === 'function') {
      probeInput = storage.getLocalPath(asset.key);
    }
    if (
      !probeInput &&
      asset.url &&
      (asset.url.startsWith('http://') || asset.url.startsWith('https://'))
    ) {
      this.logger.warn(`Remote storage without local path, probing by public URL: ${asset.url}`);
      probeInput = asset.url;
    }
    if (!probeInput) {
      this.probeJobsSkipped += 1;
      return { mediaId, durationSec: null };
    }
    try {
      const { durationSec } = await probeDuration(probeInput);
      if (durationSec != null) {
        await this.prisma.mediaAsset.update({
          where: { id: mediaId },
          data: { duration: durationSec },
        });
        this.probeJobsCompleted += 1;
      } else {
        this.probeJobsFailed += 1;
      }
      return { mediaId, durationSec };
    } catch (e) {
      this.probeJobsFailed += 1;
      this.logger.error(`Probe failed for ${mediaId}`, e as Error);
      throw e;
    }
  }

  getMetrics() {
    return {
      completed: this.probeJobsCompleted,
      failed: this.probeJobsFailed,
      skipped: this.probeJobsSkipped,
    };
  }
}
