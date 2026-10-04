import { Prisma } from '@prisma/client';
import { mirrorTranslationMetaToSeo } from './translation-meta-seo.util';

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
