import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { BookModule } from './modules/book/book.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { BookVersionModule } from './modules/book-version/book-version.module';
import { ChapterModule } from './modules/chapter/chapter.module';
import { AudioChapterModule } from './modules/audio-chapter/audio-chapter.module';
import { SeoModule } from './modules/seo/seo.module';
import { BookSummaryModule } from './modules/book-summary/book-summary.module';
import { CategoryModule } from './modules/category/category.module';
import { BookshelfModule } from './modules/bookshelf/bookshelf.module';
import { CommentsModule } from './modules/comments/comments.module';
import { CacheModule } from './shared/cache/cache.module';
import { RateLimitModule } from './shared/rate-limit/rate-limit.module';
import { LikesModule } from './modules/likes/likes.module';
import { ReadingProgressModule } from './modules/reading-progress/reading-progress.module';
import { ViewStatsModule } from './modules/view-stats/view-stats.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { StatusModule } from './modules/status/status.module';
import { TagsModule } from './modules/tags/tags.module';
import { PagesModule } from './modules/pages/pages.module';
import { MediaModule } from './modules/media/media.module';
import { PublicModule } from './modules/public/public.module';
import { SitemapModule } from './modules/sitemap/sitemap.module';
import { LanguageResolverGuard } from './common/guards/language-resolver.guard';
import { GlobalRateLimitGuard } from './common/guards/global-rate-limit.guard';
import { HealthModule } from './modules/health/health.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { QueueModule } from './modules/queue/queue.module';
import { PrismaModule } from './shared/prisma/prisma.module';
import { SecurityModule } from './shared/security/security.module';

const staticRoot = join(process.cwd(), process.env.LOCAL_UPLOADS_DIR ?? 'var/uploads');
console.log(`[AppModule] Serving static files from: ${staticRoot}`);

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    // Global shared providers
    PrismaModule,
    SecurityModule,
    // Static files for local uploads
    ServeStaticModule.forRoot({ rootPath: staticRoot, serveRoot: '/' }),
    CacheModule,
    RateLimitModule,
    BookModule,
    AuthModule,
    UsersModule,
    BookVersionModule,
    ChapterModule,
    AudioChapterModule,
    SeoModule,
    BookSummaryModule,
    CategoryModule,
    BookshelfModule,
    CommentsModule,
    LikesModule,
    ReadingProgressModule,
    ViewStatsModule,
    UploadsModule,
    StatusModule,
    TagsModule,
    PagesModule,
    MediaModule,
    PublicModule,
    SitemapModule,
    HealthModule,
    MetricsModule,
    QueueModule,
    // ...other modules
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Global throttling first
    { provide: APP_GUARD, useClass: GlobalRateLimitGuard },
    // Language resolution after throttling
    { provide: APP_GUARD, useClass: LanguageResolverGuard },
  ],
  // No exports: shared providers are exposed by global modules
})
export class AppModule {}
