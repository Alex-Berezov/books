import {
  BadRequestException,
  ConflictException,
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

/** Сколько ссылок показать в ответе: оператору нужен пример, а не полный список. */
const REFERENCE_SAMPLE_LIMIT = 3;

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

  /**
   * Кто ссылается на объект (LEGACY-060).
   *
   * Обложка и аудио связаны с ассетом **строкой URL**, а не внешним ключом,
   * поэтому база удаление не остановит: `isDeleted: true` проходит, файл исчезает,
   * а `coverImageUrl` продолжает указывать на несуществующий объект. Замечает это
   * читатель, а не оператор.
   *
   * Пока нет `BookVersion.coverMediaId` (миграция закрыла бы и LEGACY-058), ссылки
   * приходится искать по вхождению `key` в URL. Совпадение по подстроке, а не по
   * равенству: публичный адрес собирается из базы хранилища, и она может смениться,
   * а `key` — нет.
   *
   * `AudioChapter` проверяется дважды — и по `mediaId`, и по строке `audioUrl`.
   * Внешний ключ там есть, но он не мешает мягкому удалению, а часть записей могла
   * быть создана до его появления.
   */
  private async findBlockingReferences(asset: { id: string; key: string }): Promise<string[]> {
    const [covers, audioByMedia, audioByUrl, avatars, photos] = await Promise.all([
      this.prisma.bookVersion.findMany({
        where: { coverImageUrl: { contains: asset.key } },
        select: { id: true, title: true },
        take: REFERENCE_SAMPLE_LIMIT,
      }),
      this.prisma.audioChapter.findMany({
        where: { mediaId: asset.id },
        select: { id: true, title: true },
        take: REFERENCE_SAMPLE_LIMIT,
      }),
      this.prisma.audioChapter.findMany({
        where: { audioUrl: { contains: asset.key } },
        select: { id: true, title: true },
        take: REFERENCE_SAMPLE_LIMIT,
      }),
      this.prisma.user.findMany({
        where: { avatarUrl: { contains: asset.key } },
        select: { id: true },
        take: REFERENCE_SAMPLE_LIMIT,
      }),
      this.prisma.authorTranslation.findMany({
        where: { photoUrl: { contains: asset.key } },
        select: { id: true },
        take: REFERENCE_SAMPLE_LIMIT,
      }),
    ]);

    const references: string[] = [];
    for (const version of covers)
      references.push(`book version "${version.title}" (${version.id})`);
    for (const chapter of [...audioByMedia, ...audioByUrl]) {
      const descriptor = `audio chapter "${chapter.title}" (${chapter.id})`;
      if (!references.includes(descriptor)) references.push(descriptor);
    }
    for (const user of avatars) references.push(`user avatar (${user.id})`);
    for (const translation of photos) references.push(`author photo (${translation.id})`);

    return references;
  }

  async remove(id: string) {
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException('Media not found');

    const key: string = asset.key as unknown as string;

    // 🔴 Отказ вместо удаления. Восстановить объект нельзя: хранилище не версионирует,
    // и единственный путь назад — заново загрузить исходный файл, которого у оператора
    // может не быть. Поэтому сомнение разрешается в пользу отказа.
    const references = await this.findBlockingReferences({ id, key });
    if (references.length > 0) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Media is still referenced and was not deleted',
        references,
      });
    }

    await this.prisma.mediaAsset.update({ where: { id }, data: { isDeleted: true } });

    // Ошибка хранилища больше не проглатывается. Запись остаётся помеченной удалённой
    // ради идемпотентности повтора, но объект в этом случае живёт дальше и не находится
    // ни одним критерием по базе — это сирота, и о ней должно остаться свидетельство
    // (LEGACY-058: критерий сироты по FK такие объекты не видит в принципе).
    let storageDeleted = true;
    try {
      await this.storage.delete(key);
    } catch (error) {
      storageDeleted = false;
      this.logger.error(
        `Storage object was not deleted for media ${id} (key: ${key}). ` +
          'The database record is marked deleted, so the object is now an orphan and ' +
          'has to be removed by hand.',
        error instanceof Error ? error.stack : String(error),
      );
    }

    return { success: true, storageDeleted };
  }
}
