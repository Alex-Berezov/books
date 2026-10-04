import { Prisma } from '@prisma/client';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  assertTranslationSeoPatchAllowed,
  mirrorTranslationMetaToSeo,
} from './translation-meta-seo.util';

describe('mirrorTranslationMetaToSeo (LEGACY-436)', () => {
  /** `owners` — владельцы строки `Seo` для `seoOwnersCount`: по умолчанию только сам перевод. */
  const makeTx = (
    owners: Record<string, { id: string } | null> = { tagTranslation: { id: 'tr' } },
  ) => {
    const update = jest.fn().mockResolvedValue({});
    const create = jest.fn().mockResolvedValue({ id: 77 });
    const findUnique = jest.fn().mockResolvedValue(owners);
    const $queryRaw = jest.fn().mockResolvedValue([]);
    return {
      tx: {
        seo: { update, create, findUnique },
        $queryRaw,
      } as unknown as Prisma.TransactionClient,
      update,
      create,
      findUnique,
      $queryRaw,
    };
  };

  it('переносит плоские поля в существующий Seo одной записью', async () => {
    const { tx, update, create } = makeTx();
    await expect(
      mirrorTranslationMetaToSeo(tx, 5, { metaTitle: 'T', ogImageAlt: null }),
    ).resolves.toBe(5);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { metaTitle: 'T', ogImageAlt: null },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('пустая строка и пробелы пишутся в Seo как null', async () => {
    const { tx, update } = makeTx();
    await mirrorTranslationMetaToSeo(tx, 5, { metaTitle: '', ogTitle: '   ' });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { metaTitle: null, ogTitle: null },
    });
  });

  it('seo.X в том же запросе побеждает плоское X, в том числе seo.X = null', async () => {
    const { tx, update } = makeTx();
    await mirrorTranslationMetaToSeo(
      tx,
      5,
      { metaTitle: 'flat', ogTitle: 'og', ogDescription: 'flat od' },
      { metaTitle: 'seo', ogDescription: null },
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ where: { id: 5 }, data: { ogTitle: 'og' } });
  });

  it('все плоские поля перекрыты seo — без Seo строка не создаётся', async () => {
    const { tx, create, update } = makeTx();
    await expect(
      mirrorTranslationMetaToSeo(tx, null, { metaTitle: 'flat' }, { metaTitle: 'seo' }),
    ).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('создаёт Seo, если его нет и есть непустое значение', async () => {
    const { tx, create } = makeTx();
    await expect(
      mirrorTranslationMetaToSeo(tx, null, { metaTitle: 'T', ogTitle: ' ' }),
    ).resolves.toBe(77);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: { metaTitle: 'T', ogTitle: null },
      select: { id: true },
    });
  });

  it('null и пустые строки без Seo строку не создают', async () => {
    const { tx, create, update } = makeTx();
    await expect(
      mirrorTranslationMetaToSeo(tx, null, { metaTitle: null, ogTitle: '  ' }),
    ).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('запирает строку Seo до счёта владельцев', async () => {
    const { tx, $queryRaw, findUnique } = makeTx();
    await mirrorTranslationMetaToSeo(tx, 5, { metaTitle: 'T' });
    expect($queryRaw).toHaveBeenCalledTimes(1);
    expect(($queryRaw.mock.calls[0] as [TemplateStringsArray])[0].join('?')).toContain(
      'FOR UPDATE',
    );
    expect($queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      findUnique.mock.invocationCallOrder[0],
    );
  });

  it('строку Seo с другим владельцем не трогает', async () => {
    const { tx, update, create } = makeTx({
      tagTranslation: { id: 'tr' },
      page: { id: 'p' },
    });
    await expect(mirrorTranslationMetaToSeo(tx, 5, { metaTitle: 'T' })).resolves.toBe(5);
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('строку Seo, созданную тем же запросом (владельцев ещё нет), дописывает', async () => {
    const { tx, update } = makeTx({ tagTranslation: null });
    await expect(
      mirrorTranslationMetaToSeo(tx, 5, { ogTitle: 'b' }, { metaTitle: 'a' }),
    ).resolves.toBe(5);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ where: { id: 5 }, data: { ogTitle: 'b' } });
  });

  it('без плоских полей ничего не пишет', async () => {
    const { tx, create, update } = makeTx();
    await expect(mirrorTranslationMetaToSeo(tx, 5, {})).resolves.toBe(5);
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

/** Мок `tx` для счёта владельцев: `row` — то, что вернёт `seo.findUnique` (`null` — строки нет). */
const txWithRow = (row: Record<string, { id: string } | null> | null) => {
  const update = jest.fn().mockResolvedValue({});
  const findUnique = jest.fn().mockResolvedValue(row);
  const $queryRaw = jest.fn().mockResolvedValue([]);
  return {
    tx: { seo: { update, findUnique }, $queryRaw } as unknown as Prisma.TransactionClient,
    update,
    findUnique,
    $queryRaw,
  };
};

describe('mirrorTranslationMetaToSeo — строки Seo нет (LEGACY-436, T107)', () => {
  it('owners === null: не пишет и возвращает прежний seoId', async () => {
    const { tx, update } = txWithRow(null);
    await expect(mirrorTranslationMetaToSeo(tx, 5, { metaTitle: 'T' })).resolves.toBe(5);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('assertTranslationSeoPatchAllowed (LEGACY-436, T107)', () => {
  const own = { tagTranslation: { id: 'tr' } };
  const shared = { tagTranslation: { id: 'tr' }, categoryTranslation: { id: 'c' } };

  it('отвязка seo из одних null и непустое плоское X без seo.X — 400 с именем поля', async () => {
    const { tx, $queryRaw } = txWithRow(own);
    const call = assertTranslationSeoPatchAllowed(
      tx,
      5,
      { ogTitle: 'Flat' },
      { metaTitle: null, metaDescription: null },
    );
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(/ogTitle/);
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it('отвязка с 400 не зависит от seoId перевода', async () => {
    const { tx } = txWithRow(null);
    await expect(
      assertTranslationSeoPatchAllowed(tx, null, { metaTitle: 'X' }, { metaTitle: undefined }),
    ).rejects.toThrow(BadRequestException);
  });

  it('отвязка с плоским null или пробелами допустима', async () => {
    const { tx } = txWithRow(own);
    await expect(
      assertTranslationSeoPatchAllowed(
        tx,
        5,
        { metaTitle: null, ogTitle: '  ' },
        { ogImageUrl: null },
      ),
    ).resolves.toBeUndefined();
  });

  // Уточнение решения 1 (арбитр 04.10.2026): при отвязке строки `Seo` не будет, `seo.X = null`
  // ничего не выигрывает — плоское X иначе молча легло бы в колонку, которую публика не читает.
  it('отвязка с явным seo.X = null и непустым плоским X — тоже 400', async () => {
    const { tx } = txWithRow(own);
    await expect(
      assertTranslationSeoPatchAllowed(tx, 5, { metaTitle: 'X' }, { metaTitle: null }),
    ).rejects.toThrow(/metaTitle/);
  });

  it('вложенный seo в общую строку Seo — 409, строка запирается до счёта', async () => {
    const { tx, $queryRaw, findUnique } = txWithRow(shared);
    await expect(assertTranslationSeoPatchAllowed(tx, 5, {}, { metaTitle: 'Seo' })).rejects.toThrow(
      ConflictException,
    );
    expect(($queryRaw.mock.calls[0] as [TemplateStringsArray])[0].join('?')).toContain(
      'FOR UPDATE',
    );
    expect($queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      findUnique.mock.invocationCallOrder[0],
    );
  });

  it('плоское зеркало в общую строку Seo — 409', async () => {
    const { tx } = txWithRow(shared);
    await expect(assertTranslationSeoPatchAllowed(tx, 5, { metaTitle: 'Flat' })).rejects.toThrow(
      ConflictException,
    );
  });

  it('ноль владельцев (строку отпустили) — 409: «ровно один», а не «не больше одного»', async () => {
    const { tx, update } = txWithRow({ tagTranslation: null, categoryTranslation: null });
    await expect(assertTranslationSeoPatchAllowed(tx, 5, { metaTitle: 'Flat' })).rejects.toThrow(
      ConflictException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('строки Seo нет (owners === null) — 409', async () => {
    const { tx } = txWithRow(null);
    await expect(assertTranslationSeoPatchAllowed(tx, 5, { metaTitle: 'Flat' })).rejects.toThrow(
      ConflictException,
    );
  });

  it('единственный владелец — проходит', async () => {
    const { tx } = txWithRow(own);
    await expect(
      assertTranslationSeoPatchAllowed(tx, 5, { metaTitle: 'Flat' }, { ogTitle: 'Seo' }),
    ).resolves.toBeUndefined();
  });

  it('запрос без meta/OG и без данных seo — строку не запирает', async () => {
    const { tx, $queryRaw } = txWithRow(shared);
    await expect(assertTranslationSeoPatchAllowed(tx, 5, {})).resolves.toBeUndefined();
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it('у перевода нет Seo — проверки владельцев нет (новая строка создаётся без замка)', async () => {
    const { tx, $queryRaw } = txWithRow(shared);
    await expect(
      assertTranslationSeoPatchAllowed(tx, null, { metaTitle: 'Flat' }, { ogTitle: 'Seo' }),
    ).resolves.toBeUndefined();
    expect($queryRaw).not.toHaveBeenCalled();
  });
});
