import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { SRC_ROOT } from './controller-decorators';

const REPO_ROOT = join(SRC_ROOT, '..');
const SCHEMA = join(REPO_ROOT, 'prisma', 'schema.prisma');
const MIGRATIONS = join(REPO_ROOT, 'prisma', 'migrations');

/**
 * Сторож самого рубежа: `@@unique([slug])` на `Category` (`LEGACY-276`, релиз 2).
 *
 * 🔴 Заведён потому, что этот индекс уже пропадал молча. `Category_slug_key` существовал
 * с самого начала и был снят **попутно** — миграцией
 * `20250830151000_add_taxonomy_translations`, занятой переводами таксономии, одной строкой
 * `DROP INDEX` с комментарием «slugs are now unique per translation language». После этого
 * занятость базового слага полтора года держал только код, причём не везде: путь импорта
 * не проверял её вовсе и заводил дубли штатным запросом (разбор — `LEGACY-276`).
 *
 * Чего **не** ловит существующая обвязка, и почему нужна отдельная спека:
 *
 * - `yarn drift-check` сверяет `schema.prisma` с миграциями, а не с замыслом: снятие
 *   `@@unique([slug])` вместе с парной миграцией `DROP INDEX` он считает согласованным
 *   и проходит зелёным;
 * - `category-slug-writers.spec.ts` морозит перечень **писателей** слага, а не наличие
 *   ограничения: с живым перечнем и снятым индексом он тоже зелёный;
 * - ни один юнит и ни один e2e не утверждает уникальность: юниты работают на моках,
 *   а фикстуры e2e дублей базового слага не заводят.
 *
 * То есть до этой спеки повторение истории 30.08.2025 — одна строка схемы плюс одна
 * строка миграции — проходило **все** проверки обоих конвейеров. Цена ошибки при этом
 * не симметрична: `CategoryService.deadLanguagesForSlug` снимает `SlugRedirect` по слагу,
 * который без уникальности может держать вторая живая категория, и выданный 308
 * превращается в 404 на проиндексированном адресе. Гит откатывает это за минуту,
 * поисковики помнят месяцами.
 *
 * ⚠️ Спека читает файлы, а не базу: на моках уникальности не видно, а поднимать Postgres
 * ради одной строки схемы в юнит-наборе нельзя. Что индекс действительно встаёт на живой
 * базе, показывает сама миграция и её DO-блок (проба на отказ — в файле дела записи).
 */
describe('LEGACY-276: уникальность Category.slug закреплена в схеме и в миграциях', () => {
  const schema = readFileSync(SCHEMA, 'utf8');

  /** Тело модели `Category` — от `model Category {` до закрывающей скобки. */
  const categoryBlock = (() => {
    const start = schema.indexOf('model Category {');
    expect(start).toBeGreaterThan(-1);
    const end = schema.indexOf('\n}', start);
    expect(end).toBeGreaterThan(start);
    return schema.slice(start, end);
  })();

  it('schema.prisma объявляет @@unique([slug]) на Category', () => {
    // Обе формы годятся — `@@unique([slug])` и инлайновый `slug String @unique`:
    // Prisma даёт им одно и то же имя индекса `Category_slug_key`.
    const block = categoryBlock.replace(/\s+/g, ' ');
    const declared = /@@unique\(\[slug\]\)/.test(block) || /slug\s+String\s+@unique/.test(block);
    expect(declared).toBe(true);
  });

  it('уникальность объявлена именно по slug, а не только по key', () => {
    // `key String @unique` стоял в схеме и всё время, пока уникальности слага не было,
    // поэтому сам факт наличия слова `@unique` в модели ничего не доказывает.
    const withoutKeyLine = categoryBlock
      .split('\n')
      .filter((line) => !/^\s*key\s+String/.test(line))
      .join('\n')
      .replace(/\s+/g, ' ');
    const declaredForSlug =
      /@@unique\(\[slug\]\)/.test(withoutKeyLine) || /slug\s+String\s+@unique/.test(withoutKeyLine);
    expect(declaredForSlug).toBe(true);
  });

  it('индекс Category_slug_key создаётся миграцией и не снимается более поздней', () => {
    const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    let createdBy: string | null = null;
    let droppedAfter: string | null = null;

    for (const dir of dirs) {
      let sql: string;
      try {
        sql = readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
      } catch {
        continue;
      }
      // Комментарии вырезаются: про этот индекс в шапках говорят несколько миграций,
      // и совпадение по слову в прозе не является ни созданием, ни снятием.
      const code = sql
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n');
      if (!code.includes('Category_slug_key')) continue;

      if (/CREATE\s+UNIQUE\s+INDEX[^;]*"Category_slug_key"/i.test(code)) {
        createdBy = dir;
        droppedAfter = null;
      }
      if (/DROP\s+INDEX[^;]*"Category_slug_key"/i.test(code)) {
        droppedAfter = dir;
      }
    }

    expect(createdBy).not.toBeNull();
    // Последнее слово о существовании индекса обязано быть за созданием, а не за снятием:
    // ровно так `Category_slug_key` и пропал 30.08.2025 — попутной строкой чужой миграции.
    expect(droppedAfter).toBeNull();
  });
});
