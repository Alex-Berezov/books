import { Prisma } from '@prisma/client';
import { CLOSED_CLAIM_STATUSES } from './rights-claim.constants';
import { ClaimBlockScope, RightsClaimBlockStatus } from './rights-claim-interface';

/**
 * Области блока, которые закрывают запрошенную: блок на всю книгу и на языковое издание
 * закрывают всё, остальные — только свою область. Одно правило для выборки и для
 * `RightsClaimEnforcementService.scopeCovers`.
 */
export function scopesCovering(requested: ClaimBlockScope): ClaimBlockScope[] {
  return [...new Set([ClaimBlockScope.ENTIRE_BOOK, ClaimBlockScope.LANGUAGE_EDITION, requested])];
}

/**
 * Действующий блок претензии, спор по которой окончен (F03, слово владельца 18.10.2026, решение
 * арбитра `2026-10-18-f03-claim-upheld`): блок `ACTIVE`, срок не истёк, претензия в конечном
 * статусе, область закрывает запрошенную. Страну условие не читает — её сверяет вызывающий.
 *
 * Одна функция на все места, где окончённая претензия закрывает разделы пересказа (решения
 * арбитра `F03 | F03-2`, `T163 | LEGACY-490`): страница раздела, оглавление, счётчик
 * `_count.summarySections` и карта сайта (`summarySectionsVisibleWhere`, `book-card.ts`) и
 * публичный список блоков для middleware фронта. Разойдись они — карта сайта звала бы поисковик на
 * адрес, который ручка закрывает, или middleware открывал бы закрытое. С правилом владельца
 * 07.11.2026 все они берут только блок на весь мир: выборки — через `worldwideSettledClaimBlockWhere`,
 * страница раздела — вызовом `assertSettledClaimAccess` без страны (`pickMatchingBlock` отсекает
 * страновые блоки); анализ претензия не закрывает вовсе.
 */
export function settledClaimBlockWhere(
  now: Date,
  scope: ClaimBlockScope,
): Prisma.RightsClaimAccessBlockWhereInput {
  return {
    status: RightsClaimBlockStatus.ACTIVE,
    scope: { in: scopesCovering(scope) },
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    rightsClaim: { status: { in: [...CLOSED_CLAIM_STATUSES] } },
  };
}

/**
 * Тот же блок, но только **на весь мир** (`countryCode = null`): страновой блок окончённой претензии
 * не закрывает ничего (правило владельца 07.11.2026, решение арбитра `T163 | LEGACY-490`). Одно
 * условие на разделы пересказа (`summarySectionsVisibleWhere`) и список закрытий для middleware.
 */
export function worldwideSettledClaimBlockWhere(
  now: Date,
  scope: ClaimBlockScope,
): Prisma.RightsClaimAccessBlockWhereInput {
  return { ...settledClaimBlockWhere(now, scope), countryCode: null };
}
