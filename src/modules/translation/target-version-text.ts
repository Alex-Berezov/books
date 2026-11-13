import { Prisma, PublicationStatus } from '@prisma/client';
import { isBlank } from './chapter-blocks';
import { chapterPages } from './chapter-pages';
import { targetVersionBlock, TargetVersionState } from './translation-source';

/** Глав за страницу при поиске содержимого: обычно хватает первой главы с текстом. */
const CONTENT_PAGE_SIZE = 10;

/**
 * Поля версии на языке цели, по которым решает правило цели (D9): одна выборка на окно, замок
 * старта и привязку.
 */
export const TARGET_VERSION_SELECT = {
  id: true,
  language: true,
  status: true,
  _count: { select: { chapters: { where: { content: { not: '' } } } } },
} satisfies Prisma.BookVersionSelect;

export type TargetVersionRow = Prisma.BookVersionGetPayload<{
  select: typeof TARGET_VERSION_SELECT;
}>;

/**
 * В главах версии есть содержимое: видимый текст или картинка (`isBlank` нарезки; решения арбитра
 * `F05 | F05-19`, Е и круг 1 п.2): глава `<p></p>` или из одних пробелов - заготовка редактора.
 * Главы читаются страницами (`chapterPages`) до первой с содержимым.
 */
export async function versionHasContent(
  db: Prisma.TransactionClient,
  bookVersionId: string,
): Promise<boolean> {
  for await (const page of chapterPages(
    db,
    bookVersionId,
    { number: true, content: true },
    { nonEmpty: true, pageSize: CONTENT_PAGE_SIZE },
  )) {
    if (page.some((c) => !isBlank(c.content))) return true;
  }
  return false;
}

/**
 * Состояние версии на языке цели для `targetVersionBlock`. Содержимое читается только там, где
 * решает (Е): у черновика с непустыми главами и, если передан список анкеты, у языка из неё -
 * вне анкеты язык закрыт и без него, причина в окне и под замком одна, `NOT_IN_INTAKE`
 * (круг 1 п.3). `intakeTargets: undefined` - без отбора по анкете (привязка).
 */
export async function targetVersionState(
  db: Prisma.TransactionClient,
  version: TargetVersionRow,
  intakeTargets?: readonly unknown[] | null,
): Promise<TargetVersionState> {
  const inIntake =
    intakeTargets === undefined || intakeTargets?.includes(version.language) === true;
  const read =
    inIntake && version.status === PublicationStatus.draft && version._count.chapters > 0;
  return {
    status: version.status,
    hasContent: read && (await versionHasContent(db, version.id)),
  };
}

/** Причина версии на языке цели (D9) или `null` - черновик без содержимого открыт. */
export async function targetVersionReason(
  db: Prisma.TransactionClient,
  version: TargetVersionRow,
  intakeTargets?: readonly unknown[] | null,
): Promise<ReturnType<typeof targetVersionBlock>> {
  return targetVersionBlock(await targetVersionState(db, version, intakeTargets));
}
