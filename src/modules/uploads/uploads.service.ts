import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CACHE_SERVICE, CacheService } from '../../shared/cache/cache.interface';
import { Inject } from '@nestjs/common';
import { STORAGE_SERVICE, StorageService } from '../../shared/storage/storage.interface';
import { PresignRequestDto, PresignResponseDto, UploadType } from './dto/presign.dto';

@Injectable()
export class UploadsService {
  private readonly maxImageMb = Number(process.env.UPLOADS_MAX_IMAGE_MB || 5);
  private readonly maxAudioMb = Number(process.env.UPLOADS_MAX_AUDIO_MB || 100);
  private readonly ttlSec = Number(process.env.UPLOADS_PRESIGN_TTL_SEC || 600);
  private readonly allowedImage = (
    process.env.UPLOADS_ALLOWED_IMAGE_CT || 'image/jpeg,image/png,image/webp'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  private readonly allowedAudio = (
    process.env.UPLOADS_ALLOWED_AUDIO_CT || 'audio/mpeg,audio/mp4,audio/aac,audio/ogg'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  constructor(
    @Inject(CACHE_SERVICE) private readonly cache: CacheService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  async presign(input: PresignRequestDto, userId: string): Promise<PresignResponseDto> {
    const { type, contentType, size } = input;
    const { allowed, ext } = this.validate(type, contentType, size);
    if (!allowed) throw new BadRequestException('Unsupported content type');

    const key = this.generateKey(type, ext);
    const token = randomUUID();
    const ttlMs = this.ttlSec * 1000;
    const cacheKey = this.tokenKey(token);
    await this.cache.set(cacheKey, { key, userId, contentType, size }, ttlMs);

    return {
      key,
      url: '/uploads/direct',
      method: 'POST',
      headers: { 'x-upload-token': token, 'content-type': contentType },
      token,
      ttlSec: this.ttlSec,
    };
  }

  async directUpload(token: string, body: Buffer, contentType: string, userId: string) {
    const cacheKey = this.tokenKey(token);
    const data = await this.cache.get<{
      key: string;
      userId: string;
      contentType: string;
      size: number;
    }>(cacheKey);
    if (!data) throw new UnauthorizedException('Invalid or expired token');
    if (data.userId !== userId) throw new UnauthorizedException('Token not for this user');
    if (contentType !== data.contentType) throw new BadRequestException('Content-Type mismatch');
    if (body.length > data.size * 1.1)
      throw new BadRequestException('Body larger than announced size');

    await this.storage.save(data.key, body, { contentType });
    await this.cache.del(cacheKey);

    return { key: data.key, publicUrl: this.storage.getPublicUrl(data.key) };
  }

  async delete(key: string): Promise<void> {
    await this.storage.delete(key);
  }

  getPublicUrl(key: string): string {
    return this.storage.getPublicUrl(key);
  }

  private validate(type: UploadType, contentType: string, size: number) {
    const mb = 1024 * 1024;
    if (type === UploadType.cover) {
      const allowed = this.allowedImage.includes(contentType);
      const maxMb = this.maxImageMb;
      if (size > maxMb * mb) throw new BadRequestException(`Image too large. Max ${maxMb}MB`);
      const ext = this.mimeToExt(contentType);
      return { allowed, maxMb, ext };
    } else {
      const allowed = this.allowedAudio.includes(contentType);
      const maxMb = this.maxAudioMb;
      if (size > maxMb * mb) throw new BadRequestException(`Audio too large. Max ${maxMb}MB`);
      const ext = this.mimeToExt(contentType);
      return { allowed, maxMb, ext };
    }
  }

  private mimeToExt(ct: string): string {
    switch (ct) {
      case 'image/jpeg':
        return 'jpg';
      case 'image/png':
        return 'png';
      case 'image/webp':
        return 'webp';
      case 'audio/mpeg':
        return 'mp3';
      case 'audio/mp4':
        return 'm4a';
      case 'audio/aac':
        return 'aac';
      case 'audio/ogg':
        return 'ogg';
      default:
        return 'bin';
    }
  }

  private generateKey(type: UploadType, ext: string): string {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    const id = randomUUID();
    const prefix = type === UploadType.cover ? 'covers' : 'audio';
    return `${prefix}/${y}/${m}/${d}/${id}.${ext}`;
  }

  private tokenKey(token: string) {
    return `uploads:token:${token}`;
  }
}
