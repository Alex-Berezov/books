import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MEDIA_FOREIGN_KEY_RELATIONS,
  MEDIA_JSON_REFERENCE_FIELDS,
  MEDIA_TEXT_REFERENCE_FIELDS,
  MEDIA_UNREFERENCED_BY_FK,
  MEDIA_URL_REFERENCE_FIELDS,
  findMediaReferenceDescriptors,
  findReferencedAssetIds,
  findStringReferencedKeys,
} from './media-references';

/**
 * Любое строковое поле-адрес или поле-ключ. Шаблон нарочно по окончанию имени, а не по смыслу:
 * колонка `heroUrl` или `backdropStorageKey` обязана попасть в проверку или в исключения,
 * а не пройти мимо списка слов вроде `image|photo`.
 */
const URL_NAME_PATTERN = /(url|uri|href|src|key)$/i;

/**
 * Поля, которые подходят под шаблон, но ссылкой на ассет из медиатеки быть не могут. Каждое —
 * с причиной, которую держит код, а не смысл поля: «внешний адрес» причиной не считается,
 * оператор может вставить туда адрес из медиатеки.
 */
const NOT_MEDIA_REFERENCES: Record<string, string> = {
  'MediaAsset.url': 'собственный адрес ассета, а не ссылка на него',
  'MediaAsset.key': 'собственный ключ ассета, а не ссылка на него',
  'Category.key': 'идентификатор записи, не адрес',
  'Tag.key': 'идентификатор записи, не адрес',
  'Page.systemKey': 'идентификатор системной страницы, не адрес',
  'RightsLicense.licenseKey': 'идентификатор лицензии, не адрес',
  'RightsIntake.manifestStorageKey':
    'ключ приватного хранилища прав; пишет сервер (rights-intake-manifest.service.ts)',
  'RightsReviewImport.reportJsonStorageKey': 'ключ приватного хранилища прав; пишет сервер',
  'RightsReviewImport.reportMarkdownStorageKey': 'ключ приватного хранилища прав; пишет сервер',
  'RightsReviewImport.rawAgentOutputStorageKey': 'ключ приватного хранилища прав; пишет сервер',
  'RightsReviewImport.reportPdfStorageKey': 'ключ приватного хранилища прав; пишет сервер',
  'RightsReviewImport.inputManifestStorageKey': 'ключ приватного хранилища прав; пишет сервер',
  'SourceEdition.sourceFileStorageKey':
    'ключ приватного хранилища прав; пишет сервер, в DTO поля нет',
  'RightsEvidence.storageKey':
    'ключ приватного хранилища прав; пишет сервер (rights-files.service.ts)',
};

/**
 * Любое строковое поле-текст, куда редактор или оператор может вставить `<img src>` (LEGACY-421).
 * Исключений нет: ложное совпадение лишь оставляет файл, пропуск удаляет его необратимо.
 */
const TEXT_NAME_PATTERN =
  /(content|description|biography|text|summary|analysis|themes|transcript|body)/i;

/**
 * Поля, подходящие под шаблон текстов, но не текст оператора. Причина — только та, что держит
 * код: поле пишет сервер (в DTO его нет) или это собственное поле ассета.
 */
const NOT_MEDIA_TEXT_REFERENCES: Record<string, string> = {
  'MediaAsset.contentType': 'собственное поле ассета, а не ссылка на него',
  'BookVersion.rightsContentHash': 'хеш, пишет сервер (rights-content-hash.service.ts)',
  'BookVersion.rightsContentHashAlgorithmVersion':
    'версия алгоритма хеша, пишет сервер (rights-content-hash.service.ts)',
  'RightsReviewImport.reportPdfContentType': 'MIME-тип, пишет сервер из загрузки; в DTO поля нет',
  'SourceEdition.sourceFileContentType': 'MIME-тип, пишет сервер из загрузки; в DTO поля нет',
  'RightsEvidence.contentType': 'MIME-тип, пишет сервер из загрузки; в DTO поля нет',
};

/** Поля, куда редактор админки вставляет картинку из медиатеки (книга, глава, сводка, автор, категория, тег, страница, ответ на комментарий). */
const EDITOR_HTML_COLUMNS = [
  'BookVersion.description',
  'Chapter.content',
  'BookSummary.summary',
  'BookSummary.analysis',
  'BookSummary.themes',
  'AuthorTranslation.biography',
  'CategoryTranslation.description',
  'TagTranslation.description',
  'Page.content',
  'Comment.text',
];

/**
 * Json-поля, которые не проверяются. Причина — только та, что держит код: колонку пишет
 * сервер, и в DTO её нет.
 */
const NOT_MEDIA_JSON_REFERENCES: Record<string, string> = {
  'BookVersion.rightsContentHashInput':
    'снимок для правового хеша, пишет сервер (rights-content-hash.service.ts); источники проверяются своими колонками',
  'RightsActionEvent.payload': 'журнал событий, пишет сервер',
  'RightsProfileContributorEvent.payload': 'журнал событий, пишет сервер',
  'AdminAuditEvent.payload': 'журнал аудита, пишет сервер; упоминание ключа в истории — не ссылка',
  'RightsLicenseEvent.payload': 'журнал событий, пишет сервер',
  'RightsClaimEvent.payload': 'журнал событий, пишет сервер',
  'RightsNotification.payload': 'уведомление, пишет сервер (RightsNotificationsService.create)',
  'RightsRecheckEvent.payload': 'журнал событий, пишет сервер',
  'RightsLawyerReviewEvent.payload': 'журнал событий, пишет сервер',
};

const jsonFields = (): string[] =>
  Prisma.dmmf.datamodel.models.flatMap((model) =>
    model.fields
      .filter((field) => field.kind === 'scalar' && field.type === 'Json')
      .map((field) => `${model.name}.${field.name}`),
  );

/** Колонки, которые до LEGACY-413 были единственными проверяемыми, плюс пять слепых. */
const IMAGE_COLUMNS = [
  'BookVersion.coverImageUrl',
  'AudioChapter.audioUrl',
  'User.avatarUrl',
  'AuthorTranslation.photoUrl',
  'PersonTranslation.photoUrl',
  'Seo.ogImageUrl',
  'Seo.eventImageUrl',
  'CategoryTranslation.ogImageUrl',
  'TagTranslation.ogImageUrl',
];

const stringFields = (): string[] =>
  Prisma.dmmf.datamodel.models.flatMap((model) =>
    model.fields
      .filter((field) => field.kind === 'scalar' && field.type === 'String')
      .map((field) => `${model.name}.${field.name}`),
  );

/**
 * Сторож LEGACY-413: перечень колонок рукописный (решение арбитра, вариант B), поэтому
 * сверяется со схемой здесь. Строковое поле-адрес или поле-ключ, добавленное в схему без
 * записи в `MEDIA_URL_COLUMNS` и без исключения с причиной, роняет этот тест. Поля-тексты
 * и Json стережёт следующий блок (`LEGACY-421`).
 */
describe('media URL reference columns vs schema', () => {
  it('pattern catches every image column', () => {
    const missed = IMAGE_COLUMNS.filter((field) => !URL_NAME_PATTERN.test(field.split('.')[1]));
    expect(missed).toEqual([]);
  });

  it('every schema String field named like a URL or key is checked or excluded with a reason', () => {
    const unaccounted = stringFields().filter(
      (field) =>
        URL_NAME_PATTERN.test(field.split('.')[1]) &&
        !MEDIA_URL_REFERENCE_FIELDS.includes(field) &&
        !(field in NOT_MEDIA_REFERENCES),
    );
    expect(unaccounted).toEqual([]);
  });

  it('every checked column and every exclusion exists in the schema', () => {
    const fields = new Set(stringFields());
    const stale = [...MEDIA_URL_REFERENCE_FIELDS, ...Object.keys(NOT_MEDIA_REFERENCES)].filter(
      (field) => !fields.has(field),
    );
    expect(stale).toEqual([]);
  });

  it('never lists a column both as checked and as excluded, or twice', () => {
    const both = MEDIA_URL_REFERENCE_FIELDS.filter((field) => field in NOT_MEDIA_REFERENCES);
    expect(both).toEqual([]);
    expect(new Set(MEDIA_URL_REFERENCE_FIELDS).size).toBe(MEDIA_URL_REFERENCE_FIELDS.length);
  });

  it('checks every image column', () => {
    expect(IMAGE_COLUMNS.filter((field) => !MEDIA_URL_REFERENCE_FIELDS.includes(field))).toEqual(
      [],
    );
  });
});

/**
 * Сторож LEGACY-421: текст с HTML редактора и Json. Новое поле-текст или Json-поле без записи
 * в перечне роняет тест, а не отдаёт картинку из текста уборке.
 */
describe('media text and Json reference columns vs schema', () => {
  it('pattern catches every field the admin editor writes HTML into', () => {
    expect(EDITOR_HTML_COLUMNS.filter((f) => !TEXT_NAME_PATTERN.test(f.split('.')[1]))).toEqual([]);
  });

  it('checks every schema String field named like a text', () => {
    const unaccounted = stringFields().filter(
      (field) =>
        TEXT_NAME_PATTERN.test(field.split('.')[1]) &&
        !MEDIA_TEXT_REFERENCE_FIELDS.includes(field) &&
        !(field in NOT_MEDIA_TEXT_REFERENCES),
    );
    expect(unaccounted).toEqual([]);
  });

  it('every checked text column is a schema String field named like a text, once', () => {
    const fields = new Set(stringFields());
    const stray = MEDIA_TEXT_REFERENCE_FIELDS.filter(
      (field) => !fields.has(field) || !TEXT_NAME_PATTERN.test(field.split('.')[1]),
    );
    expect(stray).toEqual([]);
    expect(new Set(MEDIA_TEXT_REFERENCE_FIELDS).size).toBe(MEDIA_TEXT_REFERENCE_FIELDS.length);
  });

  it('every text exclusion exists in the schema, matches the pattern and is not also checked', () => {
    const fields = new Set(stringFields());
    const stray = Object.keys(NOT_MEDIA_TEXT_REFERENCES).filter(
      (field) =>
        !fields.has(field) ||
        !TEXT_NAME_PATTERN.test(field.split('.')[1]) ||
        MEDIA_TEXT_REFERENCE_FIELDS.includes(field),
    );
    expect(stray).toEqual([]);
  });

  it('every schema Json field is checked or excluded with a reason', () => {
    const unaccounted = jsonFields().filter(
      (field) =>
        !MEDIA_JSON_REFERENCE_FIELDS.includes(field) && !(field in NOT_MEDIA_JSON_REFERENCES),
    );
    expect(unaccounted).toEqual([]);
  });

  it('every checked Json column and every exclusion exists in the schema, once', () => {
    const fields = new Set(jsonFields());
    const listed = [...MEDIA_JSON_REFERENCE_FIELDS, ...Object.keys(NOT_MEDIA_JSON_REFERENCES)];
    expect(listed.filter((field) => !fields.has(field))).toEqual([]);
    expect(new Set(listed).size).toBe(listed.length);
  });
});

/**
 * Сторож LEGACY-413 для внешних ключей: каждая обратная связь `MediaAsset` из схемы обязана
 * быть в `MEDIA_FOREIGN_KEYS`. Новая модель с `mediaAssetId` без строки там роняет тест, а не
 * отдаёт свой файл уборке — все пять ключей `onDelete: SetNull`, база удалению не мешает.
 */
describe('media foreign keys vs schema', () => {
  /**
   * Связи, где ключ лежит в самом `MediaAsset`, а не ссылается на него. Минимальный dmmf
   * Prisma 7 не отдаёт ни `isList`, ни `relationFromFields`, поэтому сторона связи
   * называется здесь явно — с причиной, как исключения адресных колонок.
   */
  const NOT_REFERENCES_TO_ASSET: Record<string, string> = {
    createdBy: 'ключ createdById лежит в MediaAsset: это автор ассета, а не ссылка на него',
  };

  const schemaRelations = (): string[] => {
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === 'MediaAsset');
    return (model?.fields ?? [])
      .filter((field) => field.kind === 'object')
      .map((field) => field.name)
      .sort();
  };
  const referencingRelations = (): string[] =>
    schemaRelations().filter((relation) => !(relation in NOT_REFERENCES_TO_ASSET));

  it('checks every relation of MediaAsset except the excluded owning side', () => {
    expect(referencingRelations().length).toBeGreaterThan(0);
    expect([...MEDIA_FOREIGN_KEY_RELATIONS].sort()).toEqual(referencingRelations());
  });

  it('every excluded relation exists in the schema', () => {
    const relations = new Set(schemaRelations());
    expect(Object.keys(NOT_REFERENCES_TO_ASSET).filter((r) => !relations.has(r))).toEqual([]);
  });

  it('stage 1 filter requires none on every checked relation', () => {
    expect(MEDIA_UNREFERENCED_BY_FK).toEqual(
      Object.fromEntries(referencingRelations().map((relation) => [relation, { none: {} }])),
    );
  });
});

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

/** Одно условие `where`: `contains`, `not: null`, `OR` или равенство. */
const matches = (row: Row, where: Where): boolean =>
  Object.entries(where).every(([field, cond]) => {
    if (field === 'OR') return (cond as Where[]).some((part) => matches(row, part));
    const value = row[field];
    if (cond && typeof cond === 'object' && 'contains' in cond) {
      return typeof value === 'string' && value.includes(String(cond.contains));
    }
    if (cond && typeof cond === 'object' && 'not' in cond) return value != null;
    return value === cond;
  });

/**
 * Мок клиента: любой делегат, к которому обратились, фильтрует свои строки по `where`.
 * Список моделей не выписывается — новая колонка в перечне не требует правки мока.
 */
const makePrisma = (rows: Record<string, Row[]>, textRows: Record<string, string[]> = {}) => {
  const delegates: Record<string, { findMany: jest.Mock }> = {};
  // Сырой поиск по текстам и Json (`media-text-search.ts`): ответ по `textRows` — совпавшие ключи
  // (уборка) или `Model.field`+id (отказ 409), как у настоящего запроса.
  const $queryRaw = jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const found = (key: string) =>
      Object.entries(textRows).flatMap(([field, texts]) =>
        texts.filter((text) => text.includes(key)).map((_t, n) => ({ field, id: `r${n}` })),
      );
    const keys = values[0] as string[];
    if (strings.join('?').includes('AS field')) return Promise.resolve(keys.flatMap(found));
    return Promise.resolve(keys.filter((key) => found(key).length > 0).map((key) => ({ key })));
  });
  return new Proxy(delegates, {
    get: (target, model: string) =>
      model === '$queryRaw'
        ? $queryRaw
        : (target[model] ??= {
            findMany: jest.fn((args: { where?: Where; take?: number } = {}) => {
              const found = (rows[model] ?? []).filter((row) => matches(row, args.where ?? {}));
              return Promise.resolve(args.take ? found.slice(0, args.take) : found);
            }),
          }),
  }) as unknown as PrismaService;
};

const KEY = 'uploads/2026/09/og.webp';
const URL = `https://cdn.example/${KEY}`;

/** По строке на колонку, которую до LEGACY-413 не читал ни один путь. */
const PREVIOUSLY_BLIND: Array<[string, string, Row, string]> = [
  ['Seo.ogImageUrl', 'seo', { id: 7, ogImageUrl: URL }, 'seo og:image (7)'],
  ['Seo.eventImageUrl', 'seo', { id: 8, eventImageUrl: URL }, 'seo event image (8)'],
  [
    'CategoryTranslation.ogImageUrl',
    'categoryTranslation',
    { id: 'ct1', ogImageUrl: URL },
    'category og:image (ct1)',
  ],
  [
    'TagTranslation.ogImageUrl',
    'tagTranslation',
    { id: 'tt1', ogImageUrl: URL },
    'tag og:image (tt1)',
  ],
  [
    'PersonTranslation.photoUrl',
    'personTranslation',
    { id: 'pt1', photoUrl: URL },
    'person photo (pt1)',
  ],
  [
    'RightsLicense.documentUrl',
    'rightsLicense',
    { id: 'lic1', documentUrl: URL },
    'rights license document url (lic1)',
  ],
  [
    'RightsLicense.documentStorageKey',
    'rightsLicense',
    { id: 'lic2', documentStorageKey: KEY },
    'rights license document key (lic2)',
  ],
  [
    'RightsClaimAttachment.storageKey',
    'rightsClaimAttachment',
    { id: 'att2', title: 'Scan', storageKey: KEY },
    'rights claim attachment key "Scan" (att2)',
  ],
];

/** Ссылки только внешним ключом, которые до LEGACY-413 не видел ни один путь. */
const FK_ONLY: Array<[string, string, Row, string]> = [
  [
    'BookVersion.previewMediaId',
    'bookVersion',
    { id: 'v1', title: 'War and Peace', previewMediaId: 'm1' },
    'book version preview "War and Peace" (v1)',
  ],
  [
    'RightsLicense.documentMediaAssetId',
    'rightsLicense',
    { id: 'lic1', documentMediaAssetId: 'm1' },
    'rights license document (lic1)',
  ],
  [
    'RightsClaim.mediaAssetId',
    'rightsClaim',
    { id: 'cl1', mediaAssetId: 'm1' },
    'rights claim (cl1)',
  ],
  [
    'RightsClaimAttachment.mediaAssetId',
    'rightsClaimAttachment',
    { id: 'att1', title: 'DMCA notice', mediaAssetId: 'm1' },
    'rights claim attachment "DMCA notice" (att1)',
  ],
];

describe('findStringReferencedKeys', () => {
  it.each(PREVIOUSLY_BLIND)('sees a key referenced only by %s', async (_field, model, row) => {
    const referenced = await findStringReferencedKeys(makePrisma({ [model]: [row] }), [
      KEY,
      'uploads/other.webp',
    ]);
    expect([...referenced]).toEqual([KEY]);
  });

  it('asks the database only for rows matching the candidate keys', async () => {
    const prisma = makePrisma({});
    await findStringReferencedKeys(prisma, [KEY]);

    const call = (prisma as unknown as Record<string, { findMany: jest.Mock }>).seo.findMany.mock
      .calls[0][0] as { where: { OR: unknown[] } };
    expect(call.where.OR).toHaveLength(1);
  });

  it('splits many keys into bounded batches', async () => {
    const prisma = makePrisma({});
    const keys = Array.from({ length: 250 }, (_, i) => `k/${i}`);
    await findStringReferencedKeys(prisma, keys);

    const calls = (prisma as unknown as Record<string, { findMany: jest.Mock }>).user.findMany.mock
      .calls as Array<[{ where: { OR: unknown[] } }]>;
    expect(calls.map(([args]) => args.where.OR.length)).toEqual([100, 100, 50]);
  });

  it('does not query at all when there are no candidates', async () => {
    const prisma = makePrisma({});
    await findStringReferencedKeys(prisma, []);
    expect(Object.keys(prisma as object)).toEqual([]);
  });

  it('drops blank keys: `contains: ""` would match every row and stall the cleanup', async () => {
    const prisma = makePrisma({ user: [{ id: 'u1', avatarUrl: URL }] });
    const referenced = await findStringReferencedKeys(prisma, ['', '   ']);
    expect([...referenced]).toEqual([]);
    expect(Object.keys(prisma as object)).toEqual([]);
  });
});

const HTML = `<p>Intro</p><img src="${URL}" alt="">`;

/** Ключ, который R2 кодирует в адресе: пробел и кириллица (`encodeKeyPath`). */
const ODD_KEY = 'covers/обложка 1.jpg';
const ODD_URL = `https://cdn.example/${encodeURI(ODD_KEY)}`;

describe('keys that the public address encodes (LEGACY-421, K1)', () => {
  it('finds an encoded address in an address column, in HTML and in Json', async () => {
    expect(ODD_URL).not.toContain(ODD_KEY);
    const inAddress = makePrisma({ seo: [{ id: 1, ogImageUrl: ODD_URL }] });
    expect([...(await findStringReferencedKeys(inAddress, [ODD_KEY]))]).toEqual([ODD_KEY]);
    const inHtml = makePrisma({}, { 'Chapter.content': [`<img src="${ODD_URL}">`] });
    expect([...(await findStringReferencedKeys(inHtml, [ODD_KEY]))]).toEqual([ODD_KEY]);
    const inJson = makePrisma({}, { 'Page.sections': [JSON.stringify({ hero: ODD_URL })] });
    expect([...(await findStringReferencedKeys(inJson, [ODD_KEY]))]).toEqual([ODD_KEY]);
  });

  it('refuses a manual delete of an image whose address is encoded', async () => {
    const html = makePrisma({}, { 'Chapter.content': [`<img src="${ODD_URL}">`] });
    expect(await findMediaReferenceDescriptors(html, { id: 'm1', key: ODD_KEY })).toEqual([
      'Chapter.content (r0)',
    ]);
  });
});

describe('two keys sharing one form (LEGACY-421, K1)', () => {
  it('a match on a string that is one key raw and another key encoded keeps both', async () => {
    const plain = 'x/a%20b.jpg';
    const spaced = 'x/a b.jpg';
    const prisma = makePrisma({}, { 'Chapter.content': [`<img src="https://cdn/${plain}">`] });
    const referenced = await findStringReferencedKeys(prisma, [plain, spaced]);
    expect([...referenced].sort()).toEqual([plain, spaced].sort());
  });

  it('the 409 lookup sends both forms in one text query', async () => {
    const prisma = makePrisma({}, { 'Chapter.content': [`<img src="${ODD_URL}">`] });
    await findMediaReferenceDescriptors(prisma, { id: 'm1', key: ODD_KEY });
    const raw = (prisma as unknown as { $queryRaw: jest.Mock }).$queryRaw;
    expect(raw).toHaveBeenCalledTimes(1);
    expect(raw.mock.calls[0][1]).toEqual([ODD_KEY, encodeURI(ODD_KEY)]);
  });
});

describe('text search only for keys the addresses did not find', () => {
  it('does not scan texts for a key an address column already found', async () => {
    const prisma = makePrisma({ bookVersion: [{ id: 'v1', title: 'B', coverImageUrl: URL }] });
    await findStringReferencedKeys(prisma, [KEY, 'uploads/orphan.webp']);
    const raw = (prisma as unknown as { $queryRaw: jest.Mock }).$queryRaw;
    expect(raw).toHaveBeenCalledTimes(1);
    expect(raw.mock.calls[0][1]).toEqual(['uploads/orphan.webp']);
  });

  it('does not scan texts at all when every key is found by address', async () => {
    const prisma = makePrisma({ bookVersion: [{ id: 'v1', title: 'B', coverImageUrl: URL }] });
    await findStringReferencedKeys(prisma, [KEY]);
    expect((prisma as unknown as { $queryRaw: jest.Mock }).$queryRaw).not.toHaveBeenCalled();
  });
});

describe('references inside HTML and Json (LEGACY-421)', () => {
  it('sees a key used only by an image inside chapter HTML', async () => {
    const prisma = makePrisma({}, { 'Chapter.content': [HTML] });
    expect([...(await findStringReferencedKeys(prisma, [KEY, 'uploads/other.webp']))]).toEqual([
      KEY,
    ]);
  });

  it('sees a key used only inside Page.sections Json', async () => {
    const prisma = makePrisma({}, { 'Page.sections': [JSON.stringify({ hero: URL })] });
    expect([...(await findStringReferencedKeys(prisma, [KEY, 'uploads/other.webp']))]).toEqual([
      KEY,
    ]);
  });

  it('refuses a manual delete of an image used only in a chapter or in Json', async () => {
    const html = makePrisma({}, { 'Chapter.content': [HTML] });
    expect(await findMediaReferenceDescriptors(html, { id: 'm1', key: KEY })).toEqual([
      'Chapter.content (r0)',
    ]);
    const json = makePrisma({}, { 'Page.sections': [JSON.stringify({ hero: URL })] });
    expect(await findMediaReferenceDescriptors(json, { id: 'm1', key: KEY })).toEqual([
      'Page.sections (r0)',
    ]);
  });
});

describe('findReferencedAssetIds', () => {
  const withAssets = (
    fkIds: string[],
    rows: Record<string, Row[]>,
    textRows: Record<string, string[]> = {},
  ) => {
    const prisma = makePrisma(rows, textRows) as unknown as Record<string, unknown>;
    const mediaAsset = {
      findMany: jest.fn((args: { where: { id: { in: string[] } } }) =>
        Promise.resolve(args.where.id.in.filter((id) => fkIds.includes(id)).map((id) => ({ id }))),
      ),
    };
    return new Proxy(prisma, {
      get: (target, name: string) => (name === 'mediaAsset' ? mediaAsset : target[name]),
    }) as unknown as PrismaService;
  };

  it('reports assets referenced by a foreign key or by a string, and only them', async () => {
    const prisma = withAssets(['a1'], {}, { 'Chapter.content': [HTML] });
    const ids = await findReferencedAssetIds(prisma, [
      { id: 'a1', key: 'uploads/fk.webp' },
      { id: 'a2', key: KEY },
      { id: 'a3', key: 'uploads/orphan.webp' },
    ]);
    expect([...ids].sort()).toEqual(['a1', 'a2']);
  });

  it('does not query for an empty list', async () => {
    const prisma = withAssets([], {});
    expect((await findReferencedAssetIds(prisma, [])).size).toBe(0);
  });
});

describe('findMediaReferenceDescriptors', () => {
  it.each([...PREVIOUSLY_BLIND, ...FK_ONLY])(
    'reports an asset referenced only by %s',
    async (_field, model, row, expected) => {
      const references = await findMediaReferenceDescriptors(makePrisma({ [model]: [row] }), {
        id: 'm1',
        key: KEY,
      });
      expect(references).toEqual([expected]);
    },
  );

  it('lists an audio chapter found by FK and by URL once', async () => {
    const chapter = { id: 'a1', title: 'Ch 1', mediaId: 'm1', audioUrl: URL };
    const references = await findMediaReferenceDescriptors(
      makePrisma({ audioChapter: [chapter] }),
      { id: 'm1', key: KEY },
    );
    expect(references).toEqual(['audio chapter "Ch 1" (a1)']);
  });
});
