import { Prisma } from '@prisma/client';

export interface ChapterTitle {
  number: number;
  title: string;
}

/**
 * Кто ждёт досье или глоссарий: шаг чужой операции (запуск `F05-4`, сравнение, заготовка).
 * `waitingFor` - строка, которую он ждал прошлым шагом: её `failed` - отказ ждущего, а не
 * повод строить заново.
 */
export interface DossierWaiter {
  operationId: string;
  waitingFor?: string | null;
  /** Запуск ждущего (`F05-4`): операция, заведённая ради него, привязывается к нему. */
  translationRunId?: string | null;
  /**
   * Лимита ждущего не хватило на операцию досье или глоссария (Р20): запись ждущего с лимитом,
   * с которым она поместится, - той же транзакцией, что пауза его операции: опрос не видит паузу
   * без причины, а причину без паузы (решение арбитра `F05 | F05-7`, /fix В2).
   */
  onLimit?: (tx: Prisma.TransactionClient, minLimitUsd: Prisma.Decimal) => Promise<void>;
}

export interface DemandOptions {
  waiter?: DossierWaiter;
  limitUsd?: Prisma.Decimal;
  createdById?: string | null;
}

/**
 * Итог запроса досье или глоссария. `paused` и `failed` у ждущего уже записаны: его операция
 * на паузе `DOSSIER_PAUSED` (строитель на паузе, id операции досье - здесь), `LIMIT_REACHED`
 * (в остаток его лимита не помещается операция, которую он завёл бы: новое поколение досье,
 * новый или повторный глоссарий, перехват) или `STEP_FAILED` (строка не построилась) - Р20.
 */
export type Demand<Row> =
  | { status: 'ready'; row: Row }
  | { status: 'wait'; row: Row }
  | {
      status: 'paused';
      /** `null` - ждущему не хватило лимита на первое поколение, строки ещё нет. */
      row: Row | null;
      reason: 'DOSSIER_PAUSED' | 'LIMIT_REACHED';
      builderOperationId: string | null;
    }
  | { status: 'failed'; row: Row };

/** Причина, с которой строка досье закрыта без сводки, и модель, на которой это выяснилось. */
export interface DossierFailure {
  failedReason: string;
  model?: string;
}
