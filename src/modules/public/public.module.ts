import { Module } from '@nestjs/common';
import { PublicController } from './public.controller';
import { BookService } from '../book/book.service';
import { PagesService } from '../pages/pages.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LanguageResolverGuard } from '../../common/guards/language-resolver.guard';
import { LangParamPipe } from '../../common/pipes/lang-param.pipe';
import { CategoryService } from '../category/category.service';
import { TagsService } from '../tags/tags.service';

@Module({
  controllers: [PublicController],
  providers: [
    BookService,
    PagesService,
    CategoryService,
    TagsService,
    PrismaService,
    LanguageResolverGuard,
    LangParamPipe,
  ],
})
export class PublicModule {}
