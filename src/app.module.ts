import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from './prisma/prisma.service';
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
import { RolesGuard } from './common/guards/roles.guard';
import { CategoryModule } from './modules/category/category.module';
import { BookshelfModule } from './modules/bookshelf/bookshelf.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
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
    // ...другие модули
  ],
  controllers: [AppController],
  providers: [PrismaService, AppService, RolesGuard],
  exports: [PrismaService],
})
export class AppModule {}
