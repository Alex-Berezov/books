/**
 * Колонка, в тексте которой ищется ключ медиа: поле-текст или Json (`LEGACY-421`). Имя модели
 * совпадает с таблицей, имя поля — с колонкой: `@@map` и `@map` у этих полей в схеме нет.
 * Таблицы колонок — источник для сторожей схемы; сам SQL поиска пишет их литералом
 * (`media-text-search.ts`), и совпадение держит `media-text-search.spec.ts`.
 */
export interface MediaSearchedColumn {
  model: string;
  field: string;
}

/**
 * 🔴 Поля-тексты, где адрес медиа лежит внутри текста (LEGACY-421).
 *
 * Редактор админки вставляет картинку из медиатеки прямо в HTML (`<img src="…">`) — текст главы,
 * описание книги, биография автора. Сюда входит **каждая** строковая колонка схемы, в имени
 * которой есть слово из `TEXT_NAME_PATTERN` сторожа `media-references.spec.ts` (в любом месте
 * имени, не только в конце: `summaryShort`, `descriptionRu`), кроме исключений с причиной,
 * которую держит код, а не только те, что пишет редактор: в простое описание оператор тоже может вставить адрес, а ложное совпадение лишь
 * оставляет файл. Совпадение ищет база (`media-text-search.ts`): в память приходят ключи, а не
 * тексты глав.
 */
export const MEDIA_TEXT_COLUMNS: readonly MediaSearchedColumn[] = [
  ...['description', 'shortDescription', 'summaryShort', 'rightsLicenseAttributionTextRu'].map(
    (field) => ({ model: 'BookVersion', field }),
  ),
  ...['summary', 'analysis', 'themes'].map((field) => ({ model: 'BookSummary', field })),
  { model: 'Chapter', field: 'content' },
  ...['description', 'transcript'].map((field) => ({ model: 'AudioChapter', field })),
  { model: 'Comment', field: 'text' },
  ...['content', 'shortDescription'].map((field) => ({ model: 'Page', field })),
  ...['metaDescription', 'ogDescription', 'eventDescription'].map((field) => ({
    model: 'Seo',
    field,
  })),
  { model: 'AuthorTranslation', field: 'biography' },
  ...['description', 'shortDescription', 'metaDescription', 'ogDescription'].map((field) => ({
    model: 'CategoryTranslation',
    field,
  })),
  ...['description', 'shortDescription', 'metaDescription', 'ogDescription'].map((field) => ({
    model: 'TagTranslation',
    field,
  })),
  ...['biography', 'shortDescription'].map((field) => ({ model: 'PersonTranslation', field })),
  { model: 'RightsLicense', field: 'requiredAttributionText' },
  ...[
    'originalNoticeText',
    'claimedRightsDescriptionRu',
    'descriptionRu',
    'responseTextRu',
    'counterNoticeTextRu',
  ].map((field) => ({ model: 'RightsClaim', field })),
  { model: 'RightsClaimAttachment', field: 'contentType' },
  { model: 'RightsProfile', field: 'summaryRu' },
  { model: 'RightsReview', field: 'summaryRu' },
  { model: 'RightsEvidence', field: 'summaryRu' },
  { model: 'RightsAction', field: 'descriptionRu' },
  { model: 'RightsLegalChangeEvent', field: 'descriptionRu' },
  { model: 'RightsRecheckTask', field: 'descriptionRu' },
  ...['contextRu', 'opinionSummaryRu'].map((field) => ({ model: 'RightsLawyerReview', field })),
  { model: 'RightsLegalOpinion', field: 'bodyRu' },
  { model: 'RightsLawyerReviewCondition', field: 'textRu' },
];
