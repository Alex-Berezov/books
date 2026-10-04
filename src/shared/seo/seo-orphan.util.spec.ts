import { Prisma } from '@prisma/client';
import {
  deleteSeoIfUnreferenced,
  lockSeoAndCountOwners,
  SEO_OWNER_RELATIONS,
  seoOwnersCount,
} from './seo-orphan.util';

const owners = (held: string[]) =>
  Object.fromEntries(
    SEO_OWNER_RELATIONS.map((key) => [key, held.includes(key) ? { id: 'x' } : null]),
  );

const txWith = (row: Record<string, unknown> | null) => {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    seo: {
      findUnique: jest.fn().mockResolvedValue(row),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return { tx, client: tx as unknown as Prisma.TransactionClient };
};

describe('SEO_OWNER_RELATIONS', () => {
  // Образец — `media-references.spec.ts` (`LEGACY-413`): перечень связей сверяется со схемой, а не с копией.
  it('совпадает со всеми связями модели Seo в схеме', () => {
    const seo = Prisma.dmmf.datamodel.models.find((model) => model.name === 'Seo');
    const relations = (seo?.fields ?? [])
      .filter((field) => field.kind === 'object')
      .map((field) => field.name)
      .sort();

    expect([...SEO_OWNER_RELATIONS].sort()).toEqual(relations);
  });
});

describe('seoOwnersCount', () => {
  it('считает всех шестерых владельцев, а не только свою таблицу', async () => {
    const { tx, client } = txWith(owners(['page', 'categoryTranslation']));

    expect(await seoOwnersCount(client, 7)).toBe(2);
    const select = (tx.seo.findUnique.mock.calls[0][0] as { select: object }).select;
    expect(Object.keys(select).sort()).toEqual([...SEO_OWNER_RELATIONS].sort());
  });

  it('строки нет — null, а не ноль владельцев', async () => {
    expect(await seoOwnersCount(txWith(null).client, 7)).toBeNull();
  });
});

describe('lockSeoAndCountOwners', () => {
  it('запирает строку Seo и только потом считает владельцев', async () => {
    const { tx, client } = txWith(owners(['tagTranslation', 'page']));

    expect(await lockSeoAndCountOwners(client, 7)).toBe(2);
    const lockSql = (tx.$queryRaw.mock.calls[0][0] as { raw: readonly string[] }).raw.join(' ');
    expect(lockSql).toContain('FOR UPDATE');
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.seo.findUnique.mock.invocationCallOrder[0],
    );
  });

  it('строки нет — null', async () => {
    expect(await lockSeoAndCountOwners(txWith(null).client, 7)).toBeNull();
  });
});

describe('deleteSeoIfUnreferenced', () => {
  it('ничья строка удаляется — после замка строки', async () => {
    const { tx, client } = txWith(owners([]));

    await deleteSeoIfUnreferenced(client, 7);

    const lockSql = (tx.$queryRaw.mock.calls[0][0] as { raw: readonly string[] }).raw.join(' ');
    expect(lockSql).toContain('"Seo"');
    expect(lockSql).toContain('FOR UPDATE');
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.seo.findUnique.mock.invocationCallOrder[0],
    );

    expect(tx.seo.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.seo.deleteMany).toHaveBeenCalledWith({ where: { id: 7 } });
  });

  it('строку держит другая сущность — не удаляется', async () => {
    const { tx, client } = txWith(owners(['tagTranslation']));

    await deleteSeoIfUnreferenced(client, 7);

    expect(tx.seo.deleteMany).not.toHaveBeenCalled();
  });

  it('seoId нет — запросов нет', async () => {
    const { tx, client } = txWith(owners([]));

    await deleteSeoIfUnreferenced(client, null);

    expect(tx.seo.findUnique).not.toHaveBeenCalled();
  });
});
