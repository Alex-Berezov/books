import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SHORT_TEXT_MAX_LENGTH } from '../../shared/constants/validation';
import { RICH_HTML_MAX_LENGTH } from '../../shared/validators/rich-html.decorator';
import { AuthorTranslationDto } from '../../modules/author/dto/author-translation.dto';
import { CreateAuthorDto } from '../../modules/author/dto/create-author.dto';
import { UpdateAuthorDto } from '../../modules/author/dto/update-author.dto';
import { UpdateBookSummaryDto } from '../../modules/book-summary/dto/update-book-summary.dto';
import { CreateBookVersionDto } from '../../modules/book-version/dto/create-book-version.dto';
import { UpdateBookVersionDto } from '../../modules/book-version/dto/update-book-version.dto';
import { CreateCategoryTranslationDto } from '../../modules/category/dto/create-category-translation.dto';
import { UpdateCategoryTranslationDto } from '../../modules/category/dto/update-category-translation.dto';
import { CreateChapterDto } from '../../modules/chapter/dto/create-chapter.dto';
import { UpdateChapterDto } from '../../modules/chapter/dto/update-chapter.dto';
import { ImportCategoryTranslationDto } from '../../modules/import/dto/import-category.dto';
import { ImportTagTranslationDto } from '../../modules/import/dto/import-tag.dto';
import { CreatePageDto } from '../../modules/pages/dto/create-page.dto';
import { UpdatePageDto } from '../../modules/pages/dto/update-page.dto';
import { CreateBookFromClearanceDto } from '../../modules/rights-intake/dto/create-book-from-clearance.dto';
import { CreateBookFromClearanceVersionDto } from '../../modules/rights-intake/dto/create-book-from-clearance-version.dto';
import { CreateTagTranslationDto } from '../../modules/tags/dto/create-tag-translation.dto';
import { UpdateTagTranslationDto } from '../../modules/tags/dto/update-tag-translation.dto';

// Каждое поле, которое пишет HTML визуального редактора в колонку БД (LEGACY-414). Новое такое поле добавляется сюда.
const FIELDS: ReadonlyArray<[new () => object, string, number]> = [
  [CreateBookVersionDto, 'description', RICH_HTML_MAX_LENGTH.text],
  [UpdateBookVersionDto, 'description', RICH_HTML_MAX_LENGTH.text],
  [CreateBookFromClearanceVersionDto, 'description', RICH_HTML_MAX_LENGTH.text],
  [CreateChapterDto, 'content', RICH_HTML_MAX_LENGTH.body],
  [UpdateChapterDto, 'content', RICH_HTML_MAX_LENGTH.body],
  [CreatePageDto, 'content', RICH_HTML_MAX_LENGTH.body],
  [UpdatePageDto, 'content', RICH_HTML_MAX_LENGTH.body],
  [AuthorTranslationDto, 'biography', RICH_HTML_MAX_LENGTH.text],
  [CreateCategoryTranslationDto, 'description', RICH_HTML_MAX_LENGTH.text],
  [UpdateCategoryTranslationDto, 'description', RICH_HTML_MAX_LENGTH.text],
  [ImportCategoryTranslationDto, 'description', RICH_HTML_MAX_LENGTH.text],
  [CreateTagTranslationDto, 'description', RICH_HTML_MAX_LENGTH.text],
  [UpdateTagTranslationDto, 'description', RICH_HTML_MAX_LENGTH.text],
  [ImportTagTranslationDto, 'description', RICH_HTML_MAX_LENGTH.text],
  [UpdateBookSummaryDto, 'summary', RICH_HTML_MAX_LENGTH.text],
  [UpdateBookSummaryDto, 'analysis', RICH_HTML_MAX_LENGTH.text],
  [UpdateBookSummaryDto, 'themes', RICH_HTML_MAX_LENGTH.text],
];

// Простой текст из <input>/<textarea>: выводится JSX-ом, чистка HTML его бы портила. Только предел длины.
const PLAIN_TEXT_FIELDS: ReadonlyArray<[new () => object, string, number]> = [
  [CreateBookVersionDto, 'shortDescription', SHORT_TEXT_MAX_LENGTH],
  [UpdateBookVersionDto, 'shortDescription', SHORT_TEXT_MAX_LENGTH],
  [CreateBookFromClearanceVersionDto, 'shortDescription', SHORT_TEXT_MAX_LENGTH],
  [CreatePageDto, 'shortDescription', SHORT_TEXT_MAX_LENGTH],
  [UpdatePageDto, 'shortDescription', SHORT_TEXT_MAX_LENGTH],
];

const DIRTY = '<p>t</p><img src="https://cdn.example.com/x.png" onerror="alert(1)">';
const CLEAN = '<p>t</p><img src="https://cdn.example.com/x.png" />';
const PLAIN = 'Tom & Jerry <new> hits';

function fieldErrors(instance: object, field: string): string[] {
  return validateSync(instance).flatMap((e) =>
    e.property === field ? Object.keys(e.constraints ?? {}) : [],
  );
}

function expectMaxLength(Dto: new () => object, field: string, max: number): void {
  const over = plainToInstance(Dto, { [field]: 'a'.repeat(max + 1) });
  expect(fieldErrors(over, field)).toContain('maxLength');
  const edge = plainToInstance(Dto, { [field]: 'a'.repeat(max) });
  expect(fieldErrors(edge, field)).not.toContain('maxLength');
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

// Класс.поле под каждым `@RichHtml(` во всём `src`: так декоратор, поставленный мимо списка FIELDS, роняет спеку.
function decoratedFields(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(join(__dirname, '..', '..'))) {
    let currentClass = '';
    let pending = false;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const cls = /^export class (\w+)/.exec(line);
      if (cls) currentClass = cls[1];
      if (line.includes('@RichHtml(')) pending = true;
      // Объявление поля кончается `;` — так ключ многострочного объекта в декораторе (`description: '…',`) им не считается.
      const prop = /^\s+(\w+)[?!]?\s*:[^;]*;\s*$/.exec(line);
      if (pending && prop && !line.trim().startsWith('@')) {
        found.push(`${currentClass}.${prop[1]}`);
        pending = false;
      }
    }
  }
  return found.sort();
}

describe('HTML-поля DTO чистятся при записи (LEGACY-414)', () => {
  describe.each(FIELDS)('%p.%s', (Dto, field, max) => {
    it('срезает обработчик события', () => {
      const dto = plainToInstance(Dto, { [field]: DIRTY }) as Record<string, unknown>;
      expect(dto[field]).toBe(CLEAN);
    });

    it(`отклоняет длину больше ${max}`, () => {
      expectMaxLength(Dto, field, max);
    });
  });

  describe.each(PLAIN_TEXT_FIELDS)('%p.%s — простой текст', (Dto, field, max) => {
    it('не трогает текст с угловыми скобками и амперсандом', () => {
      const dto = plainToInstance(Dto, { [field]: PLAIN }) as Record<string, unknown>;
      expect(dto[field]).toBe(PLAIN);
    });

    it(`отклоняет длину больше ${max}`, () => {
      expectMaxLength(Dto, field, max);
    });
  });

  it('каждый @RichHtml в DTO стоит в списке FIELDS, и наоборот', () => {
    const listed = FIELDS.map(([Dto, field]) => `${Dto.name}.${field}`).sort();
    expect(decoratedFields()).toEqual(listed);
  });

  it('вложенные переводы автора чистятся на create и update', () => {
    for (const Dto of [CreateAuthorDto, UpdateAuthorDto]) {
      const dto = plainToInstance(Dto, { translations: [{ biography: DIRTY }] });
      expect(dto.translations?.[0]?.biography).toBe(CLEAN);
    }
  });

  it('вложенные версии заведения книги из заключения: описание чистится, короткое описание — нет', () => {
    const dto = plainToInstance(CreateBookFromClearanceDto, {
      versions: [{ description: DIRTY, shortDescription: PLAIN }],
    });
    expect(dto.versions[0].description).toBe(CLEAN);
    expect(dto.versions[0].shortDescription).toBe(PLAIN);
  });
});
