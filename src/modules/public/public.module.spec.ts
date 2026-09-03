import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { collectTransitiveImports } from '../../common/testing/module-graph';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { ModeratorRolesModule } from '../../common/roles/moderator-roles.module';
import { SlugRedirectModule } from '../slug-redirect/slug-redirect.module';
import { AuthorModule } from '../author/author.module';
import { AuthorService } from '../author/author.service';
import { BookModule } from '../book/book.module';
import { BookService } from '../book/book.service';
import { CategoryModule } from '../category/category.module';
import { CategoryService } from '../category/category.service';
import { PagesModule } from '../pages/pages.module';
import { PagesService } from '../pages/pages.service';
import { RelatedTaxonomyModule } from '../seo/related-taxonomy/related-taxonomy.module';
import { RelatedTaxonomyService } from '../seo/related-taxonomy/related-taxonomy.service';
import { TagsModule } from '../tags/tags.module';
import { TagsService } from '../tags/tags.service';
import { PublicController } from './public.controller';
import { PublicModule } from './public.module';

/**
 * Сторож `LEGACY-260`: у публичных маршрутов не должно быть собственных экземпляров сервисов.
 *
 * До 01.09.2026 `PublicModule` объявлял шесть чужих сервисов в своих `providers`, и Nest создавал
 * их заново в области видимости модуля: админская и публичная стороны работали с разными
 * экземплярами `BookService`, `CategoryService`, `TagsService`, `AuthorService`, `PagesService`
 * и `RelatedTaxonomyService`. Пока сервисы без состояния, разницы не видно — поэтому дефект
 * и прожил незамеченным; любое поле в сервисе разъехалось бы между сторонами молча.
 *
 * Краснеет от возврата дефекта: верните в `providers` `PublicModule` любой из пяти сервисов,
 * которые инжектит контроллер, — кейс увидит у него экземпляр, отличный от экземпляра
 * модуля-владельца. Шестой, `RelatedTaxonomyService`, контроллер не инжектит: его сверка идёт
 * через поле внутри `BookService`, и краснеет она от дубля в `providers` `BookModule` —
 * то есть там, где этот сервис объявлялся вторым экземпляром на самом деле.
 */
describe('PublicModule', () => {
  let moduleRef: TestingModule | undefined;

  afterEach(async () => {
    // Контейнер закрывается ровно один раз. С 03.09.2026 (`LEGACY-364`)
    // `PrismaService.onModuleDestroy` идемпотентен и второй вызов переживает,
    // но полагаться на это здесь незачем: у `pg` голый `pool.end()` дважды —
    // по-прежнему исключение, а не пустая операция.
    const opened = moduleRef;
    moduleRef = undefined;
    if (opened) await opened.close();
  });

  // `PrismaModule`, `SlugRedirectModule` и `ModeratorRolesModule` объявлены `@Global()`
  // в приложении; в тестовом контейнере глобальность не наследуется, поэтому подаются явно.
  const bootPublicModule = () =>
    Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        SlugRedirectModule,
        ModeratorRolesModule,
        PublicModule,
      ],
    }).compile();

  /**
   * Поле читается `Reflect.get`, а не приведением типа: приватные поля контроллера видны
   * только компилятору, а `eslint --fix` снимает приведение как ненужное — спека после этого
   * перестаёт собираться. Тип здесь не нужен вовсе: сравнивается идентичность объектов.
   */
  const injected = (target: object, field: string): unknown => Reflect.get(target, field);

  it('отдаёт публичному контроллеру те же экземпляры, что и модули-владельцы', async () => {
    moduleRef = await bootPublicModule();
    const container = moduleRef;
    // Сравнивается то, что инжектор положил в потребителя, а не то, что отдаёт контейнер по
    // токену: собственный провайдер `PublicModule` виден только своим потребителям, и запрос
    // по токену у корня контейнера вернул бы экземпляр владельца даже при живом дубле.
    const controller = container.get(PublicController, { strict: false });
    const books = injected(controller, 'books');

    const pairs: Array<[unknown, unknown]> = [
      [books, container.select(BookModule).get(BookService, { strict: true })],
      [
        injected(controller, 'pages'),
        container.select(PagesModule).get(PagesService, { strict: true }),
      ],
      [
        injected(controller, 'categories'),
        container.select(CategoryModule).get(CategoryService, { strict: true }),
      ],
      [
        injected(controller, 'tags'),
        container.select(TagsModule).get(TagsService, { strict: true }),
      ],
      [
        injected(controller, 'authors'),
        container.select(AuthorModule).get(AuthorService, { strict: true }),
      ],
      [
        injected(books as object, 'relatedTaxonomy'),
        container.select(RelatedTaxonomyModule).get(RelatedTaxonomyService, { strict: true }),
      ],
    ];

    // Множество вместо `toBe`: у сервисов внутри лежит клиент Prisma с круговой ссылкой
    // (`_originalClient`), и jest падает на его сериализации ещё до вывода результата.
    for (const [inController, inOwner] of pairs) {
      expect(new Set<unknown>([inController, inOwner]).size).toBe(1);
    }
  });

  it('держит граф модулей ацикличным и не ведёт обратно в публичный модуль', () => {
    const reachable = collectTransitiveImports(PublicModule);

    expect(reachable).not.toContain(undefined);
    expect(reachable).not.toContain(PublicModule);
  });
});
