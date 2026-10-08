import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfirmMediaDto, MediaListQueryDto } from './dto/create-media.dto';
import { Inject } from '@nestjs/common';
import { STORAGE_SERVICE, StorageService } from '../../shared/storage/storage.interface';
import { MediaProbeService } from '../media-jobs/media-probe.service';
import { deleteMediaObject } from './media-delete';
import { paginated } from '../../shared/dto/paginated-response.dto';
import { MEDIA_CATEGORIES, MediaCategory } from './dto/create-media.dto';

// `document` — не MIME-префикс, а «всё остальное» (LEGACY-415): та же категоризация,
// что фронт применяет к ответу (`mapBackendItemToMediaFile`). Список префиксов выводится
// из `MEDIA_CATEGORIES`, а не дублируется: новая категория в DTO не разойдётся с этим фильтром.
const KNOWN_CONTENT_TYPE_PREFIXES = MEDIA_CATEGORIES.filter((c) => c !== 'document').map(
  (c) => `${c}/`,
);

function contentTypeFilterFor(type: MediaCategory): Prisma.MediaAssetWhereInput {
  if (type === 'document') {
    return {
      AND: KNOWN_CONTENT_TYPE_PREFIXES.map((prefix) => ({
        NOT: { contentType: { startsWith: prefix } },
      })),
    };
  }
  return { contentType: { startsWith: `${type}/` } };
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private prisma: PrismaService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Optional() private readonly probe?: MediaProbeService,
  ) {}

  async confirm(dto: ConfirmMediaDto, userId: string) {
    if (!dto.key) throw new BadRequestException('key is required');
    // fill url from storage if not provided correctly
    const resolvedUrl = this.storage.getPublicUrl(dto.key);
    const url = dto.url || resolvedUrl;
    if (!url.startsWith('http')) throw new BadRequestException('Invalid url');

    const afterCommit = async (assetId: string) => {
      if (dto.contentType?.startsWith('audio/') && this.probe) {
        try {
          await this.probe.enqueueProbe(assetId);
        } catch {
          /* best-effort */
        }
      }
    };

    try {
      // идемпотентность по key
      const existing = await this.prisma.mediaAsset.findUnique({ where: { key: dto.key } });
      if (existing) {
        // update metadata if changed
        const updated = await this.prisma.mediaAsset.update({
          where: { id: existing.id },
          data: {
            url,
            contentType: dto.contentType,
            size: dto.size,
            width: dto.width,
            height: dto.height,
            hash: dto.hash,
            // Ожившему ассету дата пометки не принадлежит (LEGACY-421): stage 2 и повторный
            // DELETE читают её как срок.
            isDeleted: false,
            deletedAt: null,
          },
        });
        await afterCommit(updated.id);
        return updated;
      }
      const created = await this.prisma.mediaAsset.create({
        data: {
          key: dto.key,
          url,
          contentType: dto.contentType,
          size: dto.size,
          width: dto.width,
          height: dto.height,
          hash: dto.hash,
          createdById: userId,
        },
      });
      await afterCommit(created.id);
      return created;
    } catch (e: unknown) {
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        const found = await this.prisma.mediaAsset.findUnique({ where: { key: dto.key } });
        if (found) return found;
      }
      throw e;
    }
  }

  async list(params: MediaListQueryDto) {
    const page = params.page ?? 1;
    const limit = params.limit ?? 20;
    const skip = (page - 1) * limit;
    const where = {
      isDeleted: false,
      ...(params.q
        ? { OR: [{ key: { contains: params.q } }, { url: { contains: params.q } }] }
        : {}),
      ...(params.type ? contentTypeFilterFor(params.type) : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.mediaAsset.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.mediaAsset.count({ where }),
    ]);
    return paginated(items, { page, limit, total });
  }

  async remove(id: string) {
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException('Media not found');

    // 🔴 Отказ вместо удаления, если на объект ссылаются: восстановить его нельзя - хранилище
    // не версионирует. Протокол общий с `DELETE /uploads` (`media-delete.ts`).
    const { storageDeleted } = await deleteMediaObject(
      { prisma: this.prisma, storage: this.storage, logger: this.logger },
      { key: asset.key, asset },
    );

    return { success: true, storageDeleted };
  }
}
