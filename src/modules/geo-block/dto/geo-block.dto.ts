import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GeoBlockScope } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, IsString, Matches } from 'class-validator';

/**
 * Источник **типа** — `enum GeoBlockScope` в `schema.prisma` (`LEGACY-204`).
 *
 * 🔴 Раньше здесь стояла вторая рукописная копия тех же шести значений, а третья
 * (`ClaimBlockScope`) — в `rights-claims/rights-claim-interface.ts`; переход между ними шёл
 * двойным кастом `as unknown as`, то есть без сверки наборов вовсе. Разошлись бы копии —
 * `scopeCovers` перестал бы сопоставлять значение, и блокировка по правовой претензии
 * не сработала бы молча, в пользу открытого доступа.
 *
 * Сгенерированный клиент отдаёт это перечисление плоским const-объектом, поэтому `@IsEnum`
 * и `@ApiProperty({ enum })` читают его так же, как читали TS-enum. Реэкспорт под тем же
 * именем оставляет семь внешних потребителей этого файла нетронутыми.
 *
 * ⚠️ Единственным местом, где перечислены эти шесть значений, файл схемы при этом
 * **не стал**: те же значения выписаны строками в `rights-intake/rights-review-import
 * .validator.ts`, в JSON-схеме отчёта `rights-review-schema-1.0.ts` и в
 * `rights-claims/rights-claim.constants.ts`, а на фронте — в рукописной схеме API.
 * Со схемой их не сверяет ничто, и седьмое значение придётся вписывать туда руками.
 * Границы `LEGACY-204` покрывали три копии самого типа, эти списки в них не входили.
 */
export { GeoBlockScope };

export class CheckGeoBlockAccessDto {
  @ApiProperty({ example: 'GB', pattern: '^[A-Za-z]{2}$' })
  @IsString()
  @Matches(/^[A-Za-z]{2}$/)
  countryCode!: string;

  @ApiProperty({ enum: GeoBlockScope })
  @IsEnum(GeoBlockScope)
  scope!: GeoBlockScope;
}

export class VerifyGeoBlockRulesDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  verified!: boolean;

  // Тело запроса, а не ответа: ключа может не быть вовсе, поэтому `@ApiPropertyOptional`
  // остаётся. `type: String` обязателен и здесь - без него `design:type` объединения
  // `string | null` равен `Object`, и в схему уходит объект без свойств (`LEGACY-374`).
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Checked blocked GB and allowed US scenarios.',
  })
  @IsOptional()
  @IsString()
  notesRu?: string | null;
}

export class GeoBlockRuleDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String, nullable: true })
  bookId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  bookVersionId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  rightsProfileId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  territoryDecisionId!: string | null;

  @ApiProperty({ enum: GeoBlockScope })
  scope!: GeoBlockScope;

  @ApiProperty({ type: String, example: 'GB' })
  countryCode!: string;

  @ApiProperty({ type: String })
  accessPolicy!: string;

  @ApiProperty({ type: String, nullable: true })
  sourceFinalStatus!: string | null;

  @ApiProperty({ type: Boolean })
  isActive!: boolean;

  @ApiProperty({ type: String, nullable: true })
  reasonRu!: string | null;

  @ApiProperty({ type: String, nullable: true })
  legalBasisRu!: string | null;

  @ApiProperty({ type: String })
  generatedFrom!: string;

  @ApiProperty({ type: String })
  generatedAt!: string;

  @ApiProperty({ type: String, nullable: true })
  verifiedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  verifiedByUserId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  verificationNotesRu!: string | null;

  @ApiProperty({ type: String })
  createdAt!: string;

  @ApiProperty({ type: String })
  updatedAt!: string;
}

export class GeoBlockRulesSummaryDto {
  @ApiProperty({ type: Boolean })
  geoBlockRequired!: boolean;

  @ApiProperty({ type: Boolean })
  configured!: boolean;

  @ApiProperty({ type: String, nullable: true })
  verifiedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  lastGeneratedAt!: string | null;

  @ApiProperty({ type: Number })
  totalRulesCount!: number;

  @ApiProperty({ type: Number })
  activeRulesCount!: number;

  @ApiProperty({ type: Number })
  verifiedRulesCount!: number;

  @ApiProperty({ type: [String] })
  blockedCountries!: string[];

  @ApiProperty({ enum: GeoBlockScope, isArray: true })
  scopes!: GeoBlockScope[];
}

export class GeoBlockRulesResponseDto {
  @ApiProperty({ type: String })
  bookVersionId!: string;

  @ApiProperty({ type: [GeoBlockRuleDto] })
  rules!: GeoBlockRuleDto[];

  @ApiProperty({ type: GeoBlockRulesSummaryDto })
  summary!: GeoBlockRulesSummaryDto;
}

/**
 * Phase 12 / WP-1.2а. Health of the country source itself, not of any single version.
 * Phase 12 depends on an upstream proxy header (`CF-IPCountry`) that the application neither
 * controls nor can probe: turning off Cloudflare proxying or IP Geolocation would silently
 * disable every geo-block. These counters make that failure visible.
 */
export enum GeoCountrySourceStatus {
  /** No public request has been observed since the process started — nothing to judge by. */
  NO_DATA = 'NO_DATA',
  /** Practically every request carries a country. */
  HEALTHY = 'HEALTHY',
  /** A noticeable share of requests arrives without a country. */
  DEGRADED = 'DEGRADED',
  /** Nothing has resolved at all over a meaningful number of requests — the source is gone. */
  UNAVAILABLE = 'UNAVAILABLE',
}

export class GeoCountrySourceHealthDto {
  @ApiProperty({ enum: GeoCountrySourceStatus })
  status!: GeoCountrySourceStatus;

  @ApiProperty({ type: Number, example: 1240, description: 'Requests whose country was resolved' })
  resolvedCount!: number;

  @ApiProperty({
    type: Number,
    example: 3,
    description: 'Requests that arrived without a resolvable country',
  })
  unknownCount!: number;

  @ApiProperty({ type: Number, example: 1243 })
  totalCount!: number;

  @ApiProperty({
    example: 0.0024,
    description: 'unknownCount / totalCount, 0 when no requests yet',
  })
  unknownRatio!: number;

  @ApiProperty({
    nullable: true,
    type: String,
    example: 'cf-ipcountry',
    description: 'Header that supplied the most recent country',
  })
  lastResolvedHeader!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-07-31T12:00:00.000Z' })
  lastResolvedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-07-31T11:59:00.000Z' })
  lastUnknownAt!: string | null;

  @ApiProperty({
    example: '2026-07-31T09:00:00.000Z',
    description: 'Counters live in process memory and reset on restart; this is when they started',
  })
  windowStartedAt!: string;
}

export class GeoAccessCheckResultDto {
  @ApiProperty({ type: Boolean })
  allowed!: boolean;

  @ApiProperty({ type: String, example: 'GB' })
  countryCode!: string;

  @ApiProperty({ enum: GeoBlockScope })
  scope!: GeoBlockScope;

  @ApiProperty({ type: String, nullable: true })
  matchedRuleId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  reasonCode!: string | null;

  @ApiProperty({ type: String, nullable: true })
  messageRu!: string | null;

  @ApiProperty({ type: String, nullable: true })
  bookVersionId!: string | null;
}
