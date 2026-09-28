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
