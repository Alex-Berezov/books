import { BadRequestException, Injectable, NotFoundException, Inject } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CACHE_SERVICE, CacheService } from '../../shared/cache/cache.interface';
import { CreateViewDto } from './dto/create-view.dto';
import {
  AggregateQueryDto,
  AggregateResponseDto,
  TopViewsQueryDto,
  TopViewsResponseDto,
} from './dto/aggregate.dto';

const AGG_TTL_MS = Number(process.env.VIEWS_CACHE_TTL_MS || 30_000);

@Injectable()
export class ViewStatsService {
  constructor(
    private prisma: PrismaService,
    @Inject(CACHE_SERVICE) private cache: CacheService,
  ) {}

  async create(userId: string | null, dto: CreateViewDto): Promise<{ success: true }> {
    // Validate version exists
    const version = await this.prisma.bookVersion.findUnique({ where: { id: dto.bookVersionId } });
    if (!version) throw new NotFoundException('Book version not found');

    // Validate timestamp
    const ts = dto.timestamp ? new Date(dto.timestamp) : new Date();
    if (Number.isNaN(ts.getTime())) throw new BadRequestException('Invalid timestamp');
    if (ts.getTime() > Date.now())
      throw new BadRequestException('timestamp cannot be in the future');

    await this.prisma.viewStat.create({
      data: {
        bookVersionId: dto.bookVersionId,
        userId: userId ?? null,
        source: dto.source,
        timestamp: ts,
      },
    });
    return { success: true } as const;
  }

  private calcRange(period: string, from?: string, to?: string): { from?: Date; to?: Date } {
    if (period === 'all') return {};
    let fromDate: Date | undefined;
    let toDate: Date | undefined;
    if (from) fromDate = new Date(from);
    if (to) toDate = new Date(to);
    if (!fromDate || !toDate) {
      const now = new Date();
      toDate = toDate ?? now;
      const days = period === 'day' ? 1 : period === 'week' ? 7 : 30;
      fromDate = fromDate ?? new Date(toDate.getTime() - days * 24 * 60 * 60 * 1000);
    }
    const toValDate = toDate ?? new Date();
    if (fromDate.getTime() > toValDate.getTime()) {
      throw new BadRequestException('from must be <= to');
    }
    return { from: fromDate, to: toDate };
  }

  private aggKey(q: AggregateQueryDto): string {
    const from = q.from ?? '';
    const to = q.to ?? '';
    const source = q.source ?? '';
    return `views:agg:${q.versionId}:${q.period}:${from}:${to}:${source}`;
  }

  private topKey(q: TopViewsQueryDto): string {
    const source = q.source ?? '';
    const limit = q.limit ?? 10;
    return `views:top:${q.period}:${limit}:${source}`;
  }

  async aggregate(q: AggregateQueryDto): Promise<AggregateResponseDto> {
    const cached = await this.cache.get<AggregateResponseDto>(this.aggKey(q));
    if (cached) return cached;

    const { from, to } = this.calcRange(q.period, q.from, q.to);
    const parts: Prisma.Sql[] = [Prisma.sql`"bookVersionId" = ${q.versionId}`];
    if (q.source) parts.push(Prisma.sql`AND "source" = ${q.source}`);
    if (from) parts.push(Prisma.sql`AND "timestamp" >= ${from}`);
    if (to) parts.push(Prisma.sql`AND "timestamp" <= ${to}`);

    const stmt = Prisma.sql`
      SELECT to_char(date_trunc('day', "timestamp"), 'YYYY-MM-DD') as date,
             COUNT(*)::int as count
      FROM "ViewStat"
      WHERE ${Prisma.join(parts, ' ')}
      GROUP BY date_trunc('day', "timestamp")
      ORDER BY date_trunc('day', "timestamp") ASC
    `;
    const result = await this.prisma.$queryRaw<{ date: string; count: number }[]>(stmt);

    const total = result.reduce((acc, r) => acc + Number(r.count), 0);
    const payload: AggregateResponseDto = {
      total,
      series: result.map((r) => ({ date: r.date, count: Number(r.count) })),
    };
    await this.cache.set(this.aggKey(q), payload, AGG_TTL_MS);
    return payload;
  }

  async top(q: TopViewsQueryDto): Promise<TopViewsResponseDto> {
    const cached = await this.cache.get<TopViewsResponseDto>(this.topKey(q));
    if (cached) return cached;

    const limit = q.limit ?? 10;
    const { from, to } = this.calcRange(q.period);
    const clauses: Prisma.Sql[] = [Prisma.sql`1=1`];
    if (q.source) clauses.push(Prisma.sql`AND "source" = ${q.source}`);
    if (from) clauses.push(Prisma.sql`AND "timestamp" >= ${from}`);
    if (to) clauses.push(Prisma.sql`AND "timestamp" <= ${to}`);

    const stmt2 = Prisma.sql`
      SELECT "bookVersionId", COUNT(*)::int as count
      FROM "ViewStat"
      WHERE ${Prisma.join(clauses, ' ')}
      GROUP BY "bookVersionId"
      ORDER BY COUNT(*) DESC
      LIMIT ${Number(limit)}
    `;
    const rows = await this.prisma.$queryRaw<{ bookVersionId: string; count: number }[]>(stmt2);

    const totalVersions = rows.length;
    const payload: TopViewsResponseDto = {
      items: rows.map((r) => ({ bookVersionId: r.bookVersionId, count: Number(r.count) })),
      totalVersions,
    };
    await this.cache.set(this.topKey(q), payload, AGG_TTL_MS);
    return payload;
  }
}
