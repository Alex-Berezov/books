import { PrismaService } from '../../prisma/prisma.service';
import { MEDIA_JSON_COLUMNS } from './media-json-columns';
import { MEDIA_TEXT_COLUMNS } from './media-text-columns';
import { findKeysInTexts, findTextReferences } from './media-text-search';

/** Текст запроса, который функция отправила бы в базу. */
const capture = async (run: (prisma: PrismaService) => Promise<unknown>): Promise<string> => {
  const $queryRaw = jest.fn().mockResolvedValue([]);
  await run({ $queryRaw } as unknown as PrismaService);
  return ($queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
};

const pairs = (sql: string): string[] =>
  [...sql.matchAll(/(?:FROM|JOIN) "(\w+)" t(?:, k)? (?:WHERE|ON) t\."(\w+)"::text LIKE k\.pat/g)]
    .map(([, model, field]) => `${model}.${field}`)
    .sort();

const listed = [...MEDIA_TEXT_COLUMNS, ...MEDIA_JSON_COLUMNS]
  .map((column) => `${column.model}.${column.field}`)
  .sort();

/**
 * Сторож решения арбитра T53 (третья строка): колонки в SQL написаны литералом, чтобы их читал
 * `drift-check`, а перечень для сторожей схемы живёт в таблицах. Расхождение в любую сторону —
 * колонка, которую сторож схемы считает проверенной, а запрос не читает, или наоборот.
 */
describe('static text search SQL vs column tables (LEGACY-421)', () => {
  it('the cleanup query searches exactly the listed columns', async () => {
    expect(pairs(await capture((prisma) => findKeysInTexts(prisma, ['k'])))).toEqual(listed);
  });

  it('the 409 query searches exactly the listed columns, each labelled with itself', async () => {
    const sql = await capture((prisma) => findTextReferences(prisma, ['k'], 3));
    expect(pairs(sql)).toEqual(listed);
    const labels = [
      ...sql.matchAll(
        /SELECT '(\w+\.\w+)' AS field, t\.id::text AS id FROM "(\w+)" t, k WHERE t\."(\w+)"/g,
      ),
    ];
    expect(labels.filter(([, label, model, field]) => label !== `${model}.${field}`)).toEqual([]);
    expect(labels).toHaveLength(listed.length);
  });

  it('passes only the keys as a parameter, never a table or a column', async () => {
    const $queryRaw = jest.fn().mockResolvedValue([]);
    await findKeysInTexts({ $queryRaw } as unknown as PrismaService, ['a', 'b']);
    expect($queryRaw.mock.calls[0].slice(1)).toEqual([['a', 'b']]);
  });

  it('limits the 409 sample over all columns, not per column', async () => {
    const sql = await capture((prisma) => findTextReferences(prisma, ['k'], 3));
    expect(sql.match(/LIMIT/g)).toHaveLength(1);
    expect(sql.trimEnd().endsWith('LIMIT ?')).toBe(true);
  });

  it('does not query for an empty key list', async () => {
    const $queryRaw = jest.fn();
    const prisma = { $queryRaw } as unknown as PrismaService;
    expect(await findKeysInTexts(prisma, [])).toEqual([]);
    expect(await findTextReferences(prisma, [], 3)).toEqual([]);
    expect($queryRaw).not.toHaveBeenCalled();
  });
});
