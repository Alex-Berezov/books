import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateReadingProgressDto } from './dto/update-reading-progress.dto';

@Injectable()
export class ReadingProgressService {
  constructor(private prisma: PrismaService) {}

  async get(
    userId: string,
    versionId: string,
  ): Promise<{
    id: string;
    userId: string;
    bookVersionId: string;
    chapterNumber: number | null;
    audioChapterNumber: number | null;
    position: number;
    updatedAt: Date;
  } | null> {
    const progress = await this.prisma.readingProgress.findFirst({
      where: { userId, bookVersionId: versionId },
    });
    return progress ?? null;
  }

  async upsert(
    userId: string,
    versionId: string,
    dto: UpdateReadingProgressDto,
  ): Promise<{
    id: string;
    userId: string;
    bookVersionId: string;
    chapterNumber: number | null;
    audioChapterNumber: number | null;
    position: number;
    updatedAt: Date;
  }> {
    const version = await this.prisma.bookVersion.findUnique({ where: { id: versionId } });
    if (!version) throw new NotFoundException('BookVersion not found');

    // Validate referenced chapter/audio-chapter and position range
    if (dto.chapterNumber !== undefined) {
      const chapter = await this.prisma.chapter.findFirst({
        where: { bookVersionId: versionId, number: dto.chapterNumber },
      });
      if (!chapter) throw new NotFoundException('Chapter not found');
      if (dto.position < 0 || dto.position > 1)
        throw new BadRequestException('position must be between 0 and 1 for text chapters');
    }
    if (dto.audioChapterNumber !== undefined) {
      const audio = await this.prisma.audioChapter.findFirst({
        where: { bookVersionId: versionId, number: dto.audioChapterNumber },
      });
      if (!audio) throw new NotFoundException('AudioChapter not found');
      if (dto.position < 0 || dto.position > audio.duration)
        throw new BadRequestException(
          `position must be between 0 and ${audio.duration} seconds for audio chapters`,
        );
    }

    const data = {
      userId,
      bookVersionId: versionId,
      chapterNumber: dto.chapterNumber,
      audioChapterNumber: dto.audioChapterNumber,
      position: dto.position,
    };

    const existing = await this.prisma.readingProgress.findFirst({
      where: { userId, bookVersionId: versionId },
    });
    if (existing) {
      return this.prisma.readingProgress.update({
        where: { id: existing.id },
        data: {
          chapterNumber: dto.chapterNumber,
          audioChapterNumber: dto.audioChapterNumber,
          position: dto.position,
        },
      });
    }

    try {
      return await this.prisma.readingProgress.create({ data });
    } catch {
      // unique race fallback
      const again = await this.prisma.readingProgress.findFirst({
        where: { userId, bookVersionId: versionId },
      });
      if (again) {
        return this.prisma.readingProgress.update({
          where: { id: again.id },
          data: {
            chapterNumber: dto.chapterNumber,
            audioChapterNumber: dto.audioChapterNumber,
            position: dto.position,
          },
        });
      }
      throw new BadRequestException('Unable to upsert progress');
    }
  }
}
