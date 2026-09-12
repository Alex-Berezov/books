import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { BookModule } from './modules/book/book.module';
import { ModeratorRolesModule } from './common/roles/moderator-roles.module';
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
import { AuthorModule } from './modules/author/author.module';
import { ImportModule } from './modules/import/import.module';
import { RightsIntakeModule } from './modules/rights-intake/rights-intake.module';
import { LanguageResolverGuard } from './common/guards/language-resolver.guard';
import { GlobalRateLimitGuard } from './common/guards/global-rate-limit.guard';
import { PrivateVaryInterceptor } from './common/interceptors/private-vary.interceptor';
import { DefaultCacheControlMiddleware } from './common/middleware/default-cache-control.middleware';
import { HealthModule } from './modules/health/health.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { BackgroundJobsModule } from './modules/background-jobs/background-jobs.module';
import { QueueModule } from './modules/queue/queue.module';
import { MediaJobsModule } from './modules/media-jobs/media-jobs.module';
import { PrismaModule } from './shared/prisma/prisma.module';
import { SlugRedirectModule } from './modules/slug-redirect/slug-redirect.module';
import { SecurityModule } from './shared/security/security.module';
import { GeoBlockModule } from './modules/geo-block/geo-block.module';
import { ContributorsModule } from './modules/contributors/contributors.module';
import { PersonsModule } from './modules/persons/persons.module';
import { RightsLicensesModule } from './modules/rights-licenses/rights-licenses.module';
import { RightsClaimsModule } from './modules/rights-claims/rights-claims.module';
import { RightsAgentModule } from './modules/rights-agent/rights-agent.module';
import { RightsLawyerModule } from './modules/rights-lawyer/rights-lawyer.module';
import { RightsRecheckModule } from './modules/rights-recheck/rights-recheck.module';

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
    ModeratorRolesModule,
    SlugRedirectModule,
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
    SitemapModule,
    HealthModule,
    MetricsModule,
    // Глобальный и объявлен до потребителей: механизмы регистрируются в реестре
    // из своих же фабрик провайдеров.
    BackgroundJobsModule,
    QueueModule,
    MediaJobsModule,
    AuthorModule,
    ImportModule,
    RightsIntakeModule,
    GeoBlockModule,
    ContributorsModule,
    PersonsModule,
    RightsLicensesModule,
    RightsClaimsModule,
    RightsAgentModule,
    RightsRecheckModule,
    RightsLawyerModule,
    // ...other modules
    // 🔴 `PublicModule` — последний, и переставлять его нельзя (`LEGACY-201`).
    // Его контроллер объявлен как `@Controller(':lang')`, то есть параметр стоит
    // в первом сегменте и перехватывает любой литеральный путь той же длины,
    // объявленный ниже: `GET /admin/authors` уезжал в `:lang/authors`,
    // `LangParamPipe` получал `lang = 'admin'` и отвечал 404 — до гварда дело
    // не доходило. В файле самого маршрута этого не видно вовсе: исход решает
    // порядок модулей здесь. Инвариант стережёт `src/common/testing/module-order.spec.ts`.
    PublicModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Global throttling first
    { provide: APP_GUARD, useClass: GlobalRateLimitGuard },
    // Language resolution after throttling
    { provide: APP_GUARD, useClass: LanguageResolverGuard },
    // `LEGACY-101`, `LEGACY-108`. Второй рубеж приватного ответа —
    // `Vary: Authorization` — ставится в фазе «после», когда решение
    // `PublicCacheInterceptor` о публичности маршрута уже принято.
    // Сам `Cache-Control` ставит `DefaultCacheControlMiddleware` ниже.
    { provide: APP_INTERCEPTOR, useClass: PrivateVaryInterceptor },
  ],
  // No exports: shared providers are exposed by global modules
})
export class AppModule implements NestModule {
  /**
   * 🔴 `LEGACY-108`. Умолчание кэша — приватное, и ставится оно **middleware**,
   * а не интерцептором: гвард в Nest отрабатывает раньше интерцепторов, поэтому
   * 401 `JwtAuthGuard`, 403 `RolesGuard` и 429 `GlobalRateLimitGuard` обрывают
   * цепочку до них. Middleware идёт до гвардов и покрывает и эти пути.
   *
   * Регистрация здесь, а не в `main.ts`: набор e2e поднимает приложение из
   * `AppModule` напрямую, и `app.use` рядом с `robotsHeaderMiddleware` сторож
   * не увидел бы вовсе — проверка перестала бы уметь краснеть.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(DefaultCacheControlMiddleware).forRoutes('{*path}');
  }
}
