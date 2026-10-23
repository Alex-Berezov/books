import { TranslationRunLanguage } from '@prisma/client';

type ClosureLanguage = Pick<TranslationRunLanguage, 'id' | 'bookVersionId' | 'draftCreatedAt'>;

/**
 * Решение «исходник запуска устарел» по его незавершённым языкам (`F05-6`, 6b; решения арбитра
 * `F05 | F05-6`) - одно на шаг (`pauseStale`) и на «продолжить» (`resumeTasks`, `onResumed`).
 * `hasLiveDraft` - у какого-то языка живой черновик: он дописывает главы, исходник ему не помеха;
 * тогда языки, черновика не создававшие (`waiting`), закрываются `DOSSIER_STALE` (`stale`), а не
 * ставят запуск в тупик Р13. Черновика нет ни у кого - `waiting` ждут тупика Р13, как до 6b.
 * Удалённый черновик (`deleted`: метка создания есть, ссылки нет) закрывается `DRAFT_DELETED`
 * в обоих случаях.
 */
export interface StaleClosure {
  hasLiveDraft: boolean;
  waiting: string[];
  stale: string[];
  deleted: string[];
}

export function staleClosure(languages: readonly ClosureLanguage[]): StaleClosure {
  const hasLiveDraft = languages.some((l) => l.bookVersionId !== null);
  const waiting = languages
    .filter((l) => l.bookVersionId === null && l.draftCreatedAt === null)
    .map((l) => l.id);
  return {
    hasLiveDraft,
    waiting,
    stale: hasLiveDraft ? waiting : [],
    deleted: languages
      .filter((l) => l.bookVersionId === null && l.draftCreatedAt !== null)
      .map((l) => l.id),
  };
}
