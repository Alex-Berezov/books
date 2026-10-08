import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  PayloadTooLargeException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CACHE_SERVICE, CacheService } from '../../shared/cache/cache.interface';
import { Inject } from '@nestjs/common';
import { STORAGE_SERVICE, StorageService } from '../../shared/storage/storage.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { deleteMediaObject } from '../media/media-delete';
import { DeleteMediaResponseDto } from '../media/dto/delete-media-response.dto';
import { PresignRequestDto, PresignResponseDto, UploadType } from './dto/presign.dto';

/** Префикс ключа по типу загрузки: им пользуются и `generateKey`, и проверка ключа на удаление. */
const KEY_PREFIX: Record<UploadType, string> = {
  [UploadType.cover]: 'covers',
  [UploadType.audio]: 'audio',
};

/** Сегмент ключа: латиница, цифры, `.`, `_`, `-`; пустой, `.` и `..` отдельно отбиваются. */
const KEY_SEGMENT = /^[\w.-]+$/;

/**
 * Ключ, который выдал бы `presign` (`LEGACY-444`). Всё остальное в бакете - не загрузки: при R2
 * там же лежат файлы прав (`rights-private/...`) и чужие окружения. `.` и `..` не пропускаются:
 * `covers/./x` поиск ссылок по строке не нашёл бы, а локальный драйвер свёл бы путь к `covers/x`.
 */
function isUploadKey(key: string): boolean {
  const [prefix, ...rest] = key.split('/');
  return (
    Object.values(KEY_PREFIX).includes(prefix) &&
    rest.length > 0 &&
    rest.every((segment) => KEY_SEGMENT.test(segment) && segment !== '.' && segment !== '..')
  );
}

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);
  private readonly maxImageMb = Number(process.env.UPLOADS_MAX_IMAGE_MB || 5);
  private readonly maxAudioMb = Number(process.env.UPLOADS_MAX_AUDIO_MB || 200);
  private readonly ttlSec = Number(process.env.UPLOADS_PRESIGN_TTL_SEC || 600);
  private readonly allowedImage = (
    process.env.UPLOADS_ALLOWED_IMAGE_CT || 'image/jpeg,image/png,image/webp'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  private readonly allowedAudio = (
    process.env.UPLOADS_ALLOWED_AUDIO_CT ||
    'audio/mpeg,audio/mp4,audio/aac,audio/x-m4a,audio/ogg,audio/wav,audio/webm'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  constructor(
    @Inject(CACHE_SERVICE) private readonly cache: CacheService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly prisma: PrismaService,
  ) {}

  async presign(input: PresignRequestDto, userId: string): Promise<PresignResponseDto> {
    const { type, contentType, size } = input;
    const { allowed, ext } = this.validate(type, contentType, size);
    if (!allowed)
      throw new UnsupportedMediaTypeException(`Unsupported content type: ${contentType}`);

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

  /**
   * Удаляет загруженный объект (`LEGACY-444`):
   * - ключ только такой, какой выдаёт `presign`, иначе 400;
   * - аудио - только модератор; обложку обычный пользователь удаляет, лишь если её `MediaAsset`
   *   создал он (`createdById`); ключ без записи (presign без `POST /media/confirm`) - только модератор;
   * - дальше протокол общий с `DELETE /media/:id` (`media-delete.ts`): занятый ключ - 409 всем,
   *   запись помечается для уборки, файл удаляется.
   */
  async remove(
    key: string,
    actor: { userId: string; isModerator: boolean },
  ): Promise<DeleteMediaResponseDto> {
    if (!isUploadKey(key)) throw new BadRequestException('Unsupported upload key');
    if (!actor.isModerator && !key.startsWith(`${KEY_PREFIX[UploadType.cover]}/`)) {
      throw new ForbiddenException('Only admin or content_manager can delete audio assets');
    }
    const asset = await this.prisma.mediaAsset.findUnique({ where: { key } });
    const isOwnAsset = !!asset && !asset.isDeleted && asset.createdById === actor.userId;
    if (!actor.isModerator && !isOwnAsset) {
      throw new ForbiddenException('Only the uploader or a moderator can delete this object');
    }
    try {
      const { storageDeleted } = await deleteMediaObject(
        { prisma: this.prisma, storage: this.storage, logger: this.logger },
        { key, asset },
      );
      // `storageDeleted` - единственный сигнал, что запись и хранилище разошлись (как `DELETE /media/:id`,
      // `LEGACY-373`): без него отказ R2 выглядел бы успехом.
      return { success: true, storageDeleted };
    } catch (error) {
      // Перечень ссылок называет черновики и правовые записи - он для сотрудников, не для владельца обложки.
      if (error instanceof ConflictException && !actor.isModerator) {
        throw new ConflictException('Object is still referenced and was not deleted');
      }
      throw error;
    }
  }

  getPublicUrl(key: string): string {
    return this.storage.getPublicUrl(key);
  }

  getLimits() {
    return {
      image: {
        maxSizeMb: this.maxImageMb,
        allowedContentTypes: this.allowedImage,
      },
      audio: {
        maxSizeMb: this.maxAudioMb,
        allowedContentTypes: this.allowedAudio,
      },
      presignTtlSec: this.ttlSec,
    };
  }

  private validate(type: UploadType, contentType: string, size: number) {
    const mb = 1024 * 1024;
    if (type === UploadType.cover) {
      const allowed = this.allowedImage.includes(contentType);
      const maxMb = this.maxImageMb;
      if (size > maxMb * mb) throw new PayloadTooLargeException(`Image too large. Max ${maxMb}MB`);
      const ext = this.mimeToExt(contentType);
      return { allowed, maxMb, ext };
    } else {
      const allowed = this.allowedAudio.includes(contentType);
      const maxMb = this.maxAudioMb;
      if (size > maxMb * mb) throw new PayloadTooLargeException(`Audio too large. Max ${maxMb}MB`);
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
      case 'audio/x-m4a':
        return 'm4a';
      case 'audio/aac':
        return 'aac';
      case 'audio/ogg':
        return 'ogg';
      case 'audio/wav':
        return 'wav';
      case 'audio/webm':
        return 'webm';
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
    return `${KEY_PREFIX[type]}/${y}/${m}/${d}/${id}.${ext}`;
  }

  private tokenKey(token: string) {
    return `uploads:token:${token}`;
  }
}
