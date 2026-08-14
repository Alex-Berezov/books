import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve } from 'path';

/**
 * Сторож формы идентификаторов в `rights-claims` (`LEGACY-119`).
 *
 * Все поля-ссылки этого модуля были объявлены `@IsOptional()` плюс `@IsString()`,
 * то есть проходила любая непустая строка. Мусорное значение доходило до сервиса
 * и до базы, где превращалось либо в пустой результат поиска и 404, либо в отказ
 * на внешнем ключе, который клиент видит как 500. Ни типы, ни линт, ни ревью
 * этого не отличают от исправного: валидация формально присутствует.
 *
 * ⚠️ **Сторож требует `@IsUUID()`, а не запрещает `@IsString()`.** Разница
 * принципиальна: проверка «нет полей с `@IsString()`» проходит и на коде, где
 * валидатор снят вовсе, — а это ровно возврат дефекта. Отсюда же и сверка
 * паритета, которая считает **разные** величины: разобранные поля против сырого
 * счёта `@IsUUID(` в тех же файлах.
 *
 * ⚠️ Разбор идёт по блокам декораторов и собирает многострочный декоратор по
 * балансу скобок. Построчный разбор рвал бы блок на `@ApiPropertyOptional({`,
 * и поле с многострочным описанием молча выпадало бы из проверки.
 *
 * ⚠️ **Область — только каталог `dto/`.** Параметры пути контроллера
 * (`@Param('id') id: string`, 17 мест) сюда не входят и uuid-проверки не имеют:
 * см. `LEGACY-202`. Название спеки говорит про поля DTO, а не про модуль целиком.
 */

const DTO_DIR = resolve(__dirname, '../../modules/rights-claims/dto');
const SRC_ROOT = resolve(__dirname, '../..');

/** Ниже этих чисел обход считается сломанным, а не папка — поредевшей. */
const MIN_DTO_FILES = 13;
const MIN_ID_FIELDS = 17;

/**
 * Поля, оставленные строкой намеренно, — с причиной у каждого. Пустой список
 * здесь был бы честнее, но неверен: `uuid` у `RightsProfile` и `RightsIntake` —
 * только дефолт схемы, колонка текстовая, а идентификатор задаётся снаружи
 * (`prisma/seed.ts:99,117`, `test/helpers/book-with-rights.ts:40-41`). Пока
 * не проверено, что лежит в боевой базе, ужесточение отбило бы запрос по
 * идентификатору, который в базе валиден. Снимать записи отсюда — только вместе
 * с проверкой данных, см. `LEGACY-200`.
 */
const EXPECTED_STRING_IDS = [
  'modules/rights-claims/dto/create-rights-claim.dto.ts → rightsIntakeId',
  'modules/rights-claims/dto/create-rights-claim.dto.ts → rightsProfileId',
  'modules/rights-claims/dto/query-rights-claims.dto.ts → rightsProfileId',
];

/** Любой декоратор `class-validator`: по нему поле отличается от поля DTO ответа. */
const VALIDATOR = /@Is[A-Z]\w*\(|@Matches\(|@Min\(|@Max\(|@Length\(|@MaxLength\(|@MinLength\(/;

const stripComments = (content: string): string =>
  content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * Строка без содержимого литералов: скобки внутри
 * `@ApiPropertyOptional({ description: 'ISO date (UTC)' })` иначе перекашивают
 * баланс, и остаток файла склеивается в один блок.
 */
const stripLiterals = (line: string): string =>
  line
    .replace(/\\./g, '')
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, '``');

const balance = (line: string): number => {
  const clean = stripLiterals(line);
  return (clean.match(/\(/g) ?? []).length - (clean.match(/\)/g) ?? []).length;
};

type Field = { key: string; decorators: string };

/**
 * Поля с накопленными над ними декораторами. Многострочный декоратор
 * собирается по балансу скобок, объявление поля закрывает блок.
 */
const fieldsOf = (file: string, content: string): Field[] => {
  const lines = stripComments(content).split(/\r?\n/);
  const out: Field[] = [];
  let decorators: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    if (line.startsWith('@')) {
      let depth = 0;
      do {
        depth += balance(lines[i]);
        decorators.push(lines[i].trim());
        i += 1;
      } while (i < lines.length && depth > 0);
      continue;
    }

    const declared = line.match(/^(?:readonly\s+)?(\w+)[?!]?\s*:\s*string/);
    if (declared && decorators.length > 0) {
      out.push({ key: `${file} → ${declared[1]}`, decorators: decorators.join(' ') });
    }
    if (line !== '') decorators = [];
    i += 1;
  }

  return out;
};

/** Обход рекурсивный: подкаталог `dto/` иначе выпал бы из проверки целиком. */
const listDtos = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listDtos(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });

describe('rights-claims: поля-идентификаторы DTO валидируются как uuid', () => {
  const files = listDtos(DTO_DIR);

  const idFields: Field[] = [];
  let rawIsUuidOccurrences = 0;

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    rawIsUuidOccurrences += (stripComments(content).match(/@IsUUID\s*\(/g) ?? []).length;

    const short = relative(SRC_ROOT, file).replace(/\\/g, '/');
    for (const field of fieldsOf(short, content)) {
      // Поле DTO ответа несёт только `@ApiProperty` — валидировать там нечего.
      if (!VALIDATOR.test(field.decorators)) continue;
      if (!/[Ii]d$/.test(field.key)) continue;
      idFields.push(field);
    }
  }

  it(`находит не меньше ${MIN_DTO_FILES} файлов DTO`, () => {
    expect(files.length).toBeGreaterThanOrEqual(MIN_DTO_FILES);
  });

  it(`находит не меньше ${MIN_ID_FIELDS} валидируемых полей на Id`, () => {
    expect(idFields.length).toBeGreaterThanOrEqual(MIN_ID_FIELDS);
  });

  it('видит все @IsUUID до единого — разбор декораторов ничего не потерял', () => {
    expect(idFields.filter((f) => /@IsUUID\s*\(/.test(f.decorators)).length).toBe(
      rawIsUuidOccurrences,
    );
  });

  it('требует @IsUUID() у каждого поля на Id, кроме замороженных', () => {
    const withoutUuid = idFields
      .filter((f) => !/@IsUUID\s*\(/.test(f.decorators))
      .map((f) => f.key)
      .sort();

    expect(withoutUuid).toEqual(EXPECTED_STRING_IDS);
  });
});
