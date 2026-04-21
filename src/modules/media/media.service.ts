import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfirmMediaDto, MediaListQueryDto } from './dto/create-media.dto';
import { Inject } from '@nestjs/common';
import { STORAGE_SERVICE, StorageService } from '../../shared/storage/storage.interface';
import { MediaProbeService } from '../media-jobs/media-probe.service';

@Injectable()
export class MediaService {
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
            isDeleted: false,
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
    } catch (e: any) {
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
      ...(params.type ? { contentType: { startsWith: params.type } } : {}),
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
    return { items, total, page, limit };
  }

  async remove(id: string) {
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException('Media not found');
    // soft delete record and delete storage object as best-effort
    await this.prisma.mediaAsset.update({ where: { id }, data: { isDeleted: true } });
    try {
      const key: string = asset.key as unknown as string;
      await this.storage.delete(key);
    } catch {
      // ignore storage errors to keep idempotency
    }
    return { success: true };
  }
}
