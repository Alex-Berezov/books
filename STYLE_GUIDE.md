# Code Style Guide — Books App

Руководство по стилю кода для проекта. Основано на наблюдаемых паттернах кодовой базы и мировых best practices для NestJS + TypeScript.

---

## 1. Общие принципы

- **Читаемость > краткость.** Имя `category` понятнее, чем `c`.
- **Последовательность.** Один паттерн — везде один паттерн.
- **Минимализм.** Пишите только то, что необходимо. Без комментариев-шума, без абстракций «на потом».
- **Не ломайте существующий код.** Новые правила применяйте к новому коду; рефакторинг — отдельным PR.

---

## 2. Именование

### Переменные и функции — `camelCase`

```ts
// ✅ Правильно
const passwordHash = await argon2.hash(password);
const adminRole = await this.prisma.role.findUnique({ where: { name: 'admin' } });
const roleNamesFromDb = userRoles.map((ur) => ur.role.name);

// ❌ Неправильно
const ph = await argon2.hash(password);
const ar = await this.prisma.role.findUnique({ where: { name: 'admin' } });
```

### Без абббревиатур

Пишите полные слова. Исключения — только общепринятые: `id`, `dto`, `req`, `res`.

```ts
// ✅ Правильно
const categories = await this.prisma.category.findMany();
const version = await this.getVersion(bookId);
const totalPages = Math.ceil(total / limit);

// ❌ Неправильно
const cats = await this.prisma.category.findMany();
const v = await this.getVersion(bookId);
const tp = Math.ceil(total / limit);
```

### Булевы переменные — через `is` / `has` / `can`

```ts
const isStaff = roles.includes('admin');
const hasText = Boolean(summary.text);
const hasNext = page < totalPages;
const canEdit = user.role === 'admin';
```

### Методы — короткие глаголы (imperative mood)

```ts
// CRUD
list(), create(), update(), remove()

// Доменные
attach(), detach(), rateBook(), computeRoles(), checkSlugExists()

// Private-хелперы
private signTokens(user: User) {}
private getAverageRating(bookId: string) {}
```

### Классы — `PascalCase` + суффикс роли

| Роль        | Паттерн               | Пример                           |
| ----------- | --------------------- | -------------------------------- |
| Service     | `{Module}Service`     | `BookService`, `UsersService`    |
| Controller  | `{Module}Controller`  | `BookController`                 |
| Module      | `{Module}Module`      | `BookModule`                     |
| DTO (вход)  | `{Action}{Entity}Dto` | `CreateBookDto`, `UpdateBookDto` |
| DTO (выход) | `{Entity}ResponseDto` | `CheckBookSlugResponseDto`       |
| Guard       | `{Name}Guard`         | `JwtAuthGuard`, `RolesGuard`     |
| Pipe        | `{Name}Pipe`          | `LangParamPipe`                  |
| Filter      | `{Name}Filter`        | `SentryExceptionFilter`          |
| Exception   | `{Name}Exception`     | `RedirectException`              |

### Файлы — `kebab-case`

```
book.service.ts          book.controller.ts       book.module.ts
create-book.dto.ts       update-book.dto.ts       check-slug-query.dto.ts
jwt-auth.guard.ts        roles.guard.ts           lang-param.pipe.ts
roles.decorator.ts       language.util.ts         storage.interface.ts
book.service.spec.ts     (рядом с тестируемым файлом)
```

### Enum-ы

Prisma-generated enum — источник истины. Локальные — только если нужно переопределить.

```ts
// При маппинге Prisma-enum — lowercase значения
enum Language {
  en = 'en',
  es = 'es',
}

// Кастомные enum — PascalCase значения
enum Role {
  User = 'user',
  Admin = 'admin',
  ContentManager = 'content_manager',
}
```

### Константы

```ts
// Symbol-based injection tokens
const STORAGE_SERVICE = Symbol('STORAGE_SERVICE');
const CACHE_SERVICE = Symbol('CACHE_SERVICE');

// Regex — в shared/validators
export const SLUG_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';

// Числовые литералы — с разделителями для читаемости
const MAX_FILE_SIZE = 10_000_000; // 10 MB
const SESSION_TTL = 3600_000; // 1 hour
```

---

## 3. Импорты

Порядок групп (пустая строка между ними):

```ts
// 1. @nestjs/*
import { Injectable, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

// 2. Третьи библиотеки
import { Prisma, Language } from '@prisma/client';
import * as argon2 from 'argon2';

// 3. Node built-in (с префиксом node:)
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';

// 4. Локальные (относительные пути)
import { PrismaService } from '../../prisma/prisma.service';
import { SLUG_PATTERN } from '../../shared/validators/slug';
import { CreateBookDto } from './dto/create-book.dto';
```

- Именованные импорты предпочтительнее дефолтных
- Namespace-импорта: `import * as argon2 from 'argon2'`
- При коллизии имен — алиасы: `Language as PrismaLanguage`
- `import type` для типов: `import type { UserRole } from '@prisma/client'`

---

## 4. Структура модулей (NestJS)

```
src/
  modules/
    book/
      book.module.ts
      book.service.ts
      book.service.spec.ts
      book.controller.ts
      dto/
        create-book.dto.ts
        update-book.dto.ts
        check-slug-query.dto.ts
        check-slug-response.dto.ts
  common/
    decorators/       — @Roles(), @Language()
    guards/           — JwtAuthGuard, RolesGuard
    pipes/            — LangParamPipe
    filters/          — SentryExceptionFilter
    exceptions/       — RedirectException
    security/         — app-security.config
  shared/
    cache/            — CacheService, cache.module
    storage/          — StorageService, storage.module
    rate-limit/       — RateLimiter, rate-limit.module
    validators/       — slug, xor, exactly-one
    constants/        — validation messages
    enums/            — Language, UploadType
    language/         — language.util
    prisma/           — PrismaService
    dto/              — PaginationDto (общие DTO)
    sentry/           — SentryExceptionFilter
    security/         — security.module
```

**Правило:** `common/` — reusable инфраструктура (guard/pipe/filter/decorator). `shared/` — reusable бизнес-логика (кэш, storage, валидаторы, общие DTO). Не мешать.

---

## 5. Контроллеры

```ts
@ApiTags('books')
@Controller('books')
export class BookController {
  constructor(private readonly bookService: BookService) {}

  // check-slug ПЕРВЫЙ — иначе динамические :slug маршруты его перехватят
  @Get('check-slug')
  @ApiOperation({ summary: 'Check slug uniqueness' })
  @ApiResponse({ status: 200, type: CheckBookSlugResponseDto })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  async checkSlug(@Query() query: CheckBookSlugQueryDto) { ... }

  @Get(':slug')
  @ApiOperation({ summary: 'Get book by slug' })
  @ApiParam({ name: 'slug', pattern: SLUG_PATTERN })
  async findOne(@Param('slug') slug: string) { ... }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin)
  @ApiBearerAuth()
  async create(@Body() dto: CreateBookDto) { ... }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin)
  async remove(@Param('id', ParseUUIDPipe) id: string) { ... }
}
```

### Правила

- **REST**: множественное число для коллекций (`/books`), `/me` — исключение
- **`@Body() dto`** — всегда называть `dto`, не `body`, не `data`, не `input`
- **`@Param('id') id: string`** — параметры именовать по сущности
- **DELETE** → `@HttpCode(HttpStatus.NO_CONTENT)`
- **POST, возвращающий 200** → `@HttpCode(HttpStatus.OK)`
- **Авторизация**: `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(...)`
- **Swagger**: `@ApiTags`, `@ApiOperation`, `@ApiResponse` на каждый эндпоинт
- **RequestUser** — инлайн-интерфейс: `{ userId: string; email: string }`
- **Порядок декораторов**: маршрут → Swagger → Guards → Roles → Body/Params

---

## 6. Сервисы

### Порядок методов

```ts
@Injectable()
export class BookService {
  constructor(private prisma: PrismaService) {}

  // 1. CRUD
  async findAll(paginationDto?: PaginationDto) { ... }
  async create(data: CreateBookDto) { ... }
  async update(id: string, dto: UpdateBookDto) { ... }
  async remove(id: string) { ... }

  // 2. Доменные методы
  async rateBook(userId: string, bookId: string, score: number) { ... }
  async checkSlugExists(slug: string, excludeId?: string) { ... }

  // 3. Private-хелперы в конце
  private async getAverageRating(bookId: string): Promise<number> { ... }
  private buildWhereClause(filters: Filters) { ... }
}
```

### Паттерны

- **Early return/throw** — проверка в начале метода, не вложенность
- **Пагинация**: `Promise<{ items: T[]; total: number; page: number; limit: number }>`
- **`$transaction`** для мульти-мутаций
- **`Promise.all`** для параллельных независимых запросов
- **Идемпотентность**: если существует — вернуть существующее
- **Сообщения ошибок** — user-friendly строки: `'Book not found'`, не `'NotFoundException'`

```ts
// ✅ Правильно — early throw
async rateBook(userId: string, bookId: string, score: number) {
  const book = await this.prisma.book.findUnique({ where: { id: bookId } });
  if (!book) throw new NotFoundException(`Book with ID ${bookId} not found`);

  return this.prisma.bookRating.upsert({ ... });
}

// ❌ Неправильно — вложенность
async rateBook(userId: string, bookId: string, score: number) {
  const book = await this.prisma.book.findUnique({ where: { id: bookId } });
  if (book) {
    return this.prisma.bookRating.upsert({ ... });
  } else {
    throw new NotFoundException(`Book with ID ${bookId} not found`);
  }
}
```

---

## 7. DTO

### Create DTO — поля через `!`

```ts
export class CreateBookDto {
  @ApiProperty({ example: 'my-book' })
  @IsString()
  @Matches(SLUG_PATTERN)
  slug!: string;

  @ApiProperty({ example: 'My Book' })
  @IsString()
  @MinLength(1)
  title!: string;

  @ApiPropertyOptional({ enum: PrismaLanguage })
  @IsOptional()
  @IsIn(Object.values(PrismaLanguage))
  language?: PrismaLanguage;
}
```

### Update DTO — все поля `?` + `@IsOptional()`

```ts
export class UpdateBookDto {
  @ApiPropertyOptional({ example: 'my-book' })
  @IsOptional()
  @IsString()
  @Matches(SLUG_PATTERN)
  slug?: string;

  @ApiPropertyOptional({ example: 'My Book' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;
}
```

### Response DTO — только Swagger (без валидации)

```ts
export class CheckBookSlugResponseDto {
  @ApiProperty()
  exists!: boolean;

  @ApiPropertyOptional()
  suggestedSlug?: string;
}
```

### Правила

- Каждое поле — валидация (`class-validator`) + Swagger (`@ApiProperty`)
- Slug-поля — через `SLUG_PATTERN`/`SLUG_REGEX`
- ID-поля — `@IsUUID()`
- Enum-поля — `@IsEnum(EnumType)` или `@IsIn(Object.values(Enum))`
- Вложенные DTO — `@ValidateNested()` + `@Type(() => NestedDto)`
- Пагинация — наследовать `PaginationDto`: `extends PaginationDto`
- Файлы DTO — по одному на действие в папке `dto/`

---

## 8. Обработка ошибок

### NestJS-исключения (предпочтительно)

```ts
throw new NotFoundException(`Book with ID ${bookId} not found`);
throw new ConflictException('Email already in use');
throw new BadRequestException('Invalid credentials');
throw new UnauthorizedException('Token expired');
throw new ForbiddenException('Insufficient permissions');
```

### Prisma-ошибки

```ts
try {
  await this.prisma.user.create({ data });
} catch (e) {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    throw new ConflictException('Email already in use');
  }
  throw e;
}
```

### Non-critical cleanup

```ts
// Best-effort — не критично, если не удалось
await this.deleteSeoRecords(bookId).catch(() => {});
```

### Правила

- Сервисы бросают исключения, контроллеры **не ловят** (кроме edge cases)
- Сообщения — **строки для людей**: `'Book not found'`, не объекты
- `catch {}` с пустым телом — только для non-critical операций
- Prisma `P2002` → `ConflictException` (409)

---

## 9. Комментарии

### Когда писать

```ts
// ===== Translations (Admin) =====   — разделители секций

// 1) Collect user's comment IDs       — пошаговая сложная логика
// 2) Remove likes written by the user

// idempotent                          — пояснение неочевидного поведения
// fallback for race condition on unique constraint

// ⚠️ CRITICAL: check-slug must be the FIRST GET route
// otherwise dynamic routes (`:slug/overview`) may consume it
```

### Когда НЕ писать

```ts
// ❌ Шум — код и так понятен
// Increment page by 1
page++;

// ❌ Дублирование того, что и так видно
// Create a new user
const user = await this.prisma.user.create({ data });

// ❌ Закомментированный код — удалите, используйте git
// const old = await this.getOld(id);
```

### JSDoc — на сложных/публичных методах

```ts
/**
 * Check if a slug already exists in the database.
 * @param slug - The slug to check
 * @param excludeId - Optional book ID to exclude from the check
 * @returns The existing book or null if slug is available
 */
async checkSlugExists(slug: string, excludeId?: string): Promise<Book | null> {
  ...
}
```

---

## 10. Форматирование

Базовые правила (настоятся через `.prettierrc` + ESLint):

| Правило         | Значение                                                        |
| --------------- | --------------------------------------------------------------- |
| Кавычки         | Одинарные `'`                                                   |
| Trailing commas | Везде (`all`)                                                   |
| Ширина строки   | 100 символов                                                    |
| Табуляция       | 2 пробела                                                       |
| Точка с запятой | Да                                                              |
| `any`           | Не использовать (если очень нужно — `eslint-disable` на строку) |

### Запуск форматирования

```bash
yarn format       # Prettier на src/ и test/
yarn lint          # ESLint + fix
```

---

## 11. Тесты

### Расположение

- **Unit-тесты** (`*.spec.ts`) — рядом с тестируемым файлом: `book.service.spec.ts` рядом с `book.service.ts`
- **E2E-тесты** (`*.e2e-spec.ts`) — в папке `test/`

### Структура

```ts
describe('BookService', () => {
  let service: BookService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({ ... }).compile();
    service = module.get<BookService>(BookService);
  });

  describe('create', () => {
    it('should create a book', async () => {
      const result = await service.create(mockDto);
      expect(result).toHaveProperty('id');
    });

    it('should throw NotFoundException for missing book', async () => {
      await expect(service.findOne('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });
});
```

### Правила

- Один `describe` на метод/функциональность
- Тесты на happy path и на ошибки
- Мокать Prisma/внешние сервисы через `@nestjs/testing`
- E2E-тесты через `supertest`

---

## 12. Чеклист перед пушом

```bash
# 1. Форматирование
yarn format

# 2. Линтер
yarn lint

# 3. Тайпчек
yarn typecheck

# 4. Unit-тесты
yarn test

# 5. E2E-тесты (если менялись эндпоинты)
yarn test:e2e
```

### Что проверить визуально

- [ ] Имена переменных/функций — читабельные, без абббревиатур
- [ ] Импорты — правильный порядок групп
- [ ] DTO — валидация + Swagger на каждом поле
- [ ] Контроллер — `@UseGuards`, `@Roles`, `@ApiTags` на каждом эндпоинте
- [ ] Сервис — early throw, нет вложенности
- [ ] Ошибки — NestJS-исключения, не голые `Error`
- [ ] Нет закомментированного кода
- [ ] Нет `any` (или есть `eslint-disable` с причиной)
