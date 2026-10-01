import { Prisma } from '@prisma/client';
import {
  foreignKeyViolationTargets,
  uniqueViolationFields,
  violationModelName,
} from './prisma-error.util';

const p2002 = (meta: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test', meta });

describe('uniqueViolationFields', () => {
  // Форма, снятая с живой базы под `@prisma/adapter-pg` (Prisma 7.8, 26.09.2026).
  it('берёт поля из driverAdapterError, когда meta.target нет', () => {
    const error = p2002({
      modelName: 'Page',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          kind: 'UniqueConstraintViolation',
          constraint: { fields: ['language', 'slug'] },
        },
      },
    });

    expect(uniqueViolationFields(error)).toEqual(['language', 'slug']);
  });

  // Postgres берёт имя в смешанном регистре в кавычки: `Key ("seoId")=(5)`.
  it('снимает кавычки с имени колонки из текста ошибки', () => {
    const error = p2002({
      driverAdapterError: { cause: { constraint: { fields: ['"seoId"'] } } },
    });

    expect(uniqueViolationFields(error)).toEqual(['seoId']);
  });

  it('meta.target массивом', () => {
    expect(uniqueViolationFields(p2002({ target: ['seoId'] }))).toEqual(['seoId']);
  });

  it('meta.target строкой', () => {
    expect(uniqueViolationFields(p2002({ target: 'key' }))).toEqual(['key']);
  });

  // `LEGACY-400`, пачка `T80`: тип ошибки адаптера допускает имя индекса вместо полей.
  const byIndex = (index: string, modelName?: string) =>
    p2002({
      ...(modelName ? { modelName } : {}),
      driverAdapterError: {
        cause: { kind: 'UniqueConstraintViolation', constraint: { index } },
      },
    });

  it('берёт поля из имени индекса cause.constraint.index', () => {
    expect(uniqueViolationFields(byIndex('BookVersion_language_slug_key', 'BookVersion'))).toEqual([
      'language',
      'slug',
    ]);
    expect(uniqueViolationFields(byIndex('Page_seoId_key', 'Page'))).toEqual(['seoId']);
    expect(uniqueViolationFields(byIndex('"Category_key_key"', 'Category'))).toEqual(['key']);
  });

  // Колонка с `@map` несёт своё подчёркивание (`systemKey @map("system_key")`, индекс из миграции
  // `20260809000000_page_system_key`): разбор по `_` дал бы ложные `system` и `key`.
  it('колонку с подчёркиванием из @map разбирает целиком', () => {
    expect(uniqueViolationFields(byIndex('Page_language_system_key_key', 'Page'))).toEqual([
      'language',
      'system_key',
    ]);
  });

  it('без modelName имя индекса не разбирается — пусто, а не догадка', () => {
    expect(uniqueViolationFields(byIndex('BookVersion_bookId_language_key'))).toEqual([]);
  });

  it('имя индекса не по соглашению Prisma или чужая колонка — пусто', () => {
    expect(uniqueViolationFields(byIndex('custom_unique_idx', 'Page'))).toEqual([]);
    expect(uniqueViolationFields(byIndex('Category_key_key', 'Page'))).toEqual([]);
    expect(uniqueViolationFields(byIndex('Page_nope_key', 'Page'))).toEqual([]);
    expect(uniqueViolationFields(byIndex('_key', 'Page'))).toEqual([]);
    expect(uniqueViolationFields(byIndex('Page_seoId_key', 'NoSuchModel'))).toEqual([]);
  });

  it('fields важнее index, если адаптер отдал оба', () => {
    const error = p2002({
      driverAdapterError: { cause: { constraint: { fields: ['slug'], index: 'Page_seoId_key' } } },
    });

    expect(uniqueViolationFields(error)).toEqual(['slug']);
  });

  it('ни одной известной формы — пусто', () => {
    expect(uniqueViolationFields(p2002({ modelName: 'Page' }))).toEqual([]);
  });
});

describe('foreignKeyViolationTargets', () => {
  const p2003 = (meta: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: 'test', meta });

  // Форма `@prisma/adapter-pg` (ветка кода 23503): имя ограничения — в `cause.constraint.index`.
  it('берёт имя ограничения из driverAdapterError', () => {
    const error = p2003({
      modelName: 'Page',
      driverAdapterError: {
        cause: { kind: 'ForeignKeyConstraintViolation', constraint: { index: 'Page_seoId_fkey' } },
      },
    });

    expect(foreignKeyViolationTargets(error)).toEqual(['Page_seoId_fkey']);
  });

  it('берёт колонку, когда адаптер отдал fields', () => {
    const error = p2003({
      driverAdapterError: { cause: { constraint: { fields: ['seoId'] } } },
    });

    expect(foreignKeyViolationTargets(error)).toEqual(['seoId']);
  });

  it('meta.constraint клиента без адаптера', () => {
    expect(foreignKeyViolationTargets(p2003({ constraint: 'Page_seoId_fkey' }))).toEqual([
      'Page_seoId_fkey',
    ]);
  });
});

describe('violationModelName', () => {
  const err = (meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('x', { code: 'P2002', clientVersion: 't', meta });

  it('имя модели из meta.modelName', () => {
    expect(violationModelName(err({ modelName: 'BookVersion' }))).toBe('BookVersion');
  });

  it('нет meta или не строка — undefined', () => {
    expect(violationModelName(err())).toBeUndefined();
    expect(violationModelName(err({ modelName: 1 }))).toBeUndefined();
  });
});
