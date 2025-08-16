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
import { RolesGuard } from './common/guards/roles.guard';

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
    // ...другие модули
  ],
  controllers: [AppController],
  providers: [PrismaService, AppService, RolesGuard],
  exports: [PrismaService],
})
export class AppModule {}
