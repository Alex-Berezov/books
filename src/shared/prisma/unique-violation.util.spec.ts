import { Prisma } from '@prisma/client';
import { uniqueViolationFields } from './unique-violation.util';

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
