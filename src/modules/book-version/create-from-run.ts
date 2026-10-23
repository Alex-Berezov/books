import { Prisma } from '@prisma/client';

/**
 * Режим «от запуска перевода» метода `BookVersionService.create` (`F05-6`, 6b; Р6, Р11, Р12).
 * Запуск создаёт черновик языка тем же методом, что редактор, - с теми же предусловиями, но
 * ему нужен отказ, который можно разобрать кодом, а не текстом ошибки HTTP.
 */
export interface CreateFromRun {
  /** Свой запуск: незавершённым переводом языка для собственного черновика он не считается. */
  runId: string;
  /** Выполняется в транзакции создания: ссылка языка запуска на версию пишется вместе с ней. */
  afterCreate: (tx: Prisma.TransactionClient, version: { id: string }) => Promise<void>;
}

export const CREATE_FROM_RUN_REJECTIONS = {
  /** На язык уже есть версия - найдена под замком языка или по уникальному индексу. */
  VERSION_EXISTS: 'VERSION_EXISTS',
  /** Любое иное предусловие: язык убрали из анкеты, нет разрешения прав, слаг занят. */
  CREATE_REJECTED: 'CREATE_REJECTED',
} as const;

export type CreateFromRunRejectionCode =
  (typeof CREATE_FROM_RUN_REJECTIONS)[keyof typeof CREATE_FROM_RUN_REJECTIONS];

/** Отказ создания версии запуском: код и текст сервиса (для `CREATE_REJECTED` - его причина). */
export class CreateFromRunRejectedError extends Error {
  constructor(
    readonly code: CreateFromRunRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = 'CreateFromRunRejectedError';
  }
}
