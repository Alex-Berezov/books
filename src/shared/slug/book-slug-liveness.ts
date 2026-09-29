import { Prisma } from '@prisma/client';
import { getSupportedLanguages } from '../language/language.util';

/**
 * Жив ли книжный слаг после того, как его отпустила удалённая сущность, — один предикат
 * на оба пути удаления (`BookService.remove`, `BookVersionService.remove`; `LEGACY-395`,
 * `LEGACY-320` пачка `T71`). Повторяет то, как публичный `getOverview` резолвит адрес:
 * любая опубликованная версия с этим слагом в любом языке у любой книги; её нет —
 * `Book.slug` другой книги (фоллбэк срабатывает и без единой живой версии).
 *
 * Ответ бинарный и языконезависимый: мёртвый слаг снимает `SlugRedirect` во всех пяти
 * языках, а не только в языке удалённой строки.
 *
 * 🔴 `language: { in: ... }` — у `BookVersion` нет индекса с ведущим `slug`, только
 * `@@unique([language, slug])`. Без языка запрос читает таблицу целиком внутри транзакции,
 * держащей замки на каскадно удалённых строках (тот же приём, что у
 * `CategoryService.deadLanguagesForSlug`). Значений не сужает: `getSupportedLanguages()` —
 * весь enum.
 *
 * Зовётся **после** удаления и только клиентом транзакции: своя же строка в ответе
 * участвовать не должна.
 */
export async function isBookSlugLive(tx: Prisma.TransactionClient, slug: string): Promise<boolean> {
  const liveVersion = await tx.bookVersion.findFirst({
    where: { slug, status: 'published', language: { in: getSupportedLanguages() } },
    select: { id: true },
  });
  if (liveVersion) return true;

  const liveBook = await tx.book.findFirst({ where: { slug }, select: { id: true } });
  return !!liveBook;
}
