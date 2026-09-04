import { GeoBlockScope } from '@prisma/client';

/**
 * Девять перечислений претензий читаются прямо из сгенерированного клиента, а не рукописной
 * копией (`LEGACY-344`, решение арбитра от 04.09.2026 — `decisions-log.md`): наборы значений
 * сверены построчно с `prisma/schema.prisma:2306-2413` и совпадают дословно. Имена экспортов
 * не изменились, поэтому переход не тронул ни один из потребителей (`rights-claim.constants.ts`,
 * DTO, сервисы, `book-version.service.ts`, спеки).
 */
export {
  RightsClaimType,
  RightsClaimStatus,
  RightsClaimSeverity,
  RightsClaimChannel,
  RightsClaimantType,
  RightsClaimResolution,
  RightsClaimBlockStatus,
  RightsClaimAttachmentType,
  RightsClaimEventType,
} from '@prisma/client';

/**
 * Access-block scopes reuse the Phase 12 `GeoBlockScope` enum — и теперь **буквально** его,
 * а не рукописную копию тех же значений (`LEGACY-204`).
 *
 * 🔴 Прежнее обоснование копии («the generated Prisma client is not regenerated in this
 * repository») устарело: клиент сгенерирован и знает `GeoBlockScope`. Пока копий было две,
 * переход между ними шёл двойным кастом в `geo-block-rule.service.ts`, и расхождение наборов
 * прошло бы молча — `scopeCovers` не сопоставил бы новое значение ни с чем, то есть отказ
 * случился бы в пользу открытого доступа. Имя `ClaimBlockScope` сохранено как алиас: его
 * читают сервисы претензий, их DTO и спеки.
 */
export const ClaimBlockScope = GeoBlockScope;
export type ClaimBlockScope = GeoBlockScope;

export { toStringArray } from '../rights-licenses/rights-license-interface';
