import { Injectable } from '@nestjs/common';
import {
  RegionalRightsStatus,
  TerritoryRegionCountryDto,
  TerritoryRegionReasonDto,
  TerritoryRegionSummaryDto,
} from './dto/territory-region-summary.dto';

export interface FixedRegionDefinition {
  regionCode: string;
  label: string;
  countryCodes: string[];
}

export const FIXED_REGIONS: FixedRegionDefinition[] = [
  {
    regionCode: 'US',
    label: 'United States',
    countryCodes: ['US'],
  },
  {
    regionCode: 'EU',
    label: 'European Union',
    countryCodes: [
      'AT',
      'BE',
      'BG',
      'HR',
      'CY',
      'CZ',
      'DK',
      'EE',
      'FI',
      'FR',
      'DE',
      'GR',
      'HU',
      'IE',
      'IT',
      'LV',
      'LT',
      'LU',
      'MT',
      'NL',
      'PL',
      'PT',
      'RO',
      'SK',
      'SI',
      'ES',
      'SE',
    ],
  },
  {
    regionCode: 'UK',
    label: 'United Kingdom',
    countryCodes: ['GB'],
  },
  {
    regionCode: 'CA',
    label: 'Canada',
    countryCodes: ['CA'],
  },
  {
    regionCode: 'AU_NZ',
    label: 'Australia / New Zealand',
    countryCodes: ['AU', 'NZ'],
  },
  {
    regionCode: 'LATAM',
    label: 'Latin America',
    countryCodes: [
      'AR',
      'BO',
      'BR',
      'CL',
      'CO',
      'CR',
      'CU',
      'DO',
      'EC',
      'SV',
      'GT',
      'HN',
      'MX',
      'NI',
      'PA',
      'PY',
      'PE',
      'PR',
      'UY',
      'VE',
    ],
  },
  {
    regionCode: 'RU_MARKETS',
    label: 'Russian-speaking Markets',
    countryCodes: ['RU', 'BY', 'KZ', 'KG', 'AM', 'AZ', 'GE', 'MD', 'TJ', 'TM', 'UZ', 'UA'],
  },
];

/**
 * Строка `TerritoryDecision` в том виде, в каком её отдаёт динамический делегат: значения
 * колонок типизированы `unknown` (ADR-011). WP-10.4 (R6-05): раньше здесь стоял
 * `Record<string, any>` — единственный `any` в ядре прав; он же снимал единственную защиту,
 * которая поймала бы обращение к несуществующему полю.
 */
type TerritoryDecisionRecord = Record<string, unknown>;

/** Читает строковую колонку делегата, подставляя запасное значение вместо пустого. */
const readString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' && value !== '' ? value : fallback;

/** Читает необязательную строковую колонку делегата. */
const readNullableString = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

@Injectable()
export class TerritoryRegionAggregationService {
  aggregateTerritoryDecisions(decisions: TerritoryDecisionRecord[]): TerritoryRegionSummaryDto[] {
    if (!decisions || decisions.length === 0) {
      return FIXED_REGIONS.map((r) =>
        this.createEmptyRegionSummary(r.regionCode, r.label, r.countryCodes.length),
      );
    }

    const decisionMap = new Map<string, TerritoryDecisionRecord>();
    for (const d of decisions) {
      const countryCode = d ? readNullableString(d['countryCode']) : null;
      if (countryCode) {
        decisionMap.set(countryCode.toUpperCase(), d);
      }
    }

    const fixedCountryCodeSet = new Set<string>();
    for (const r of FIXED_REGIONS) {
      for (const cc of r.countryCodes) {
        fixedCountryCodeSet.add(cc);
      }
    }

    const result: TerritoryRegionSummaryDto[] = [];

    // Process fixed regions
    for (const reg of FIXED_REGIONS) {
      const regionDecisions: TerritoryDecisionRecord[] = [];
      for (const cc of reg.countryCodes) {
        const item = decisionMap.get(cc);
        if (item) {
          regionDecisions.push(item);
        }
      }

      result.push(
        this.buildRegionSummary(
          reg.regionCode,
          reg.label,
          reg.countryCodes.length,
          regionDecisions,
        ),
      );
    }

    // Process OTHER region (ungrouped targeted countries)
    const otherDecisions: TerritoryDecisionRecord[] = [];
    for (const [countryCode, decision] of decisionMap.entries()) {
      if (!fixedCountryCodeSet.has(countryCode)) {
        otherDecisions.push(decision);
      }
    }

    if (otherDecisions.length > 0) {
      result.push(
        this.buildRegionSummary(
          'OTHER',
          'Other / Ungrouped',
          otherDecisions.length,
          otherDecisions,
        ),
      );
    }

    return result;
  }

  private createEmptyRegionSummary(
    regionCode: string,
    label: string,
    countryCount: number,
  ): TerritoryRegionSummaryDto {
    return {
      regionCode,
      label,
      status: 'NOT_TARGETED',
      countryCount,
      targetedCountryCount: 0,
      allowedCountryCount: 0,
      licensedCountryCount: 0,
      blockedCountryCount: 0,
      licenseRequiredCountryCount: 0,
      pendingReviewCountryCount: 0,
      notTargetedCountryCount: countryCount,
      undecidedCountryCount: countryCount,
      geoBlockRequiredCount: 0,
      countries: [],
      blockingReasons: [],
    };
  }

  private buildRegionSummary(
    regionCode: string,
    label: string,
    totalCountryCount: number,
    decisions: TerritoryDecisionRecord[],
  ): TerritoryRegionSummaryDto {
    if (decisions.length === 0) {
      return this.createEmptyRegionSummary(regionCode, label, totalCountryCount);
    }

    let allowedCount = 0;
    let licensedCount = 0;
    let blockedCount = 0;
    let licenseRequiredCount = 0;
    let pendingCount = 0;
    let notTargetedDecisionCount = 0;
    let geoBlockCount = 0;

    const countriesDto: TerritoryRegionCountryDto[] = [];
    const blockingReasonsDto: TerritoryRegionReasonDto[] = [];

    for (const d of decisions) {
      const countryCode = readString(d['countryCode']).toUpperCase();
      const finalStatus = readString(d['finalStatus'], 'PENDING_REVIEW').toUpperCase();
      const accessPolicy = readString(d['accessPolicy'], 'REVIEW_REQUIRED').toUpperCase();
      const geoBlockRequired = Boolean(d['geoBlockRequired']);
      const reasonRu = readString(d['reasonRu']);
      const legalBasisRu = readNullableString(d['legalBasisRu']);

      if (geoBlockRequired) {
        geoBlockCount++;
      }

      // Phase 15: a country cleared by license counts as allowed for regional roll-ups,
      // and is additionally tracked in licensedCountryCount.
      const isLicensed = finalStatus === 'ALLOWED_BY_LICENSE' && accessPolicy !== 'BLOCK';
      if (isLicensed) {
        licensedCount++;
      }

      // WP-10.4 (R6-05): значения сверяются с enum'ом `TerritoryRightsStatus`, а не с
      // `essence-of-copyright.md`. `PUBLIC_DOMAIN` и `UNCERTAIN` в enum'е отсутствуют —
      // ветки под них не срабатывали ни разу и лишь утверждали читателя в том, что такие
      // статусы бывают. Незнакомый статус трактуется в пользу проверки (ветка `else` ниже).
      const isAllowed =
        finalStatus === 'ALLOWED' ||
        isLicensed ||
        (finalStatus === 'ALLOWED_AFTER_CHANGES' && accessPolicy !== 'BLOCK');

      const isBlocked = finalStatus === 'BLOCKED' || accessPolicy === 'BLOCK';
      const isLicenseRequired = finalStatus === 'LICENSE_REQUIRED';
      const isPending = finalStatus === 'PENDING_REVIEW' || finalStatus === 'NOT_CHECKED';
      // WP-10.5 (R6-03): `NOT_TARGETED` — решение «рынок не обслуживается», а не открытый
      // вопрос. Такая страна не «на проверке», не блокирует регион и не является причиной
      // блокировки: публиковаться там никто не собирался, блокировать нечего.
      const isNotTargeted = finalStatus === 'NOT_TARGETED';

      if (isNotTargeted) {
        notTargetedDecisionCount++;
      } else if (isBlocked) {
        blockedCount++;
      } else if (isLicenseRequired) {
        licenseRequiredCount++;
      } else if (isPending) {
        pendingCount++;
      } else if (isAllowed) {
        allowedCount++;
      } else {
        pendingCount++;
      }

      countriesDto.push({
        countryCode,
        finalStatus,
        accessPolicy,
        geoBlockRequired,
        geoBlockScope: readNullableString(d['geoBlockScope']),
        reasonRu,
        legalBasisRu,
        confidence: readString(d['confidence'], 'MEDIUM'),
        nextReviewAt: this.toIsoDate(d['nextReviewAt']),
      });

      if (!isAllowed && !isNotTargeted) {
        blockingReasonsDto.push({
          countryCode,
          finalStatus,
          accessPolicy,
          reasonRu,
          legalBasisRu,
        });
      }
    }

    // WP-10.5 (R6-04): «целевые» — только страны с решением, которое не говорит
    // `NOT_TARGETED`. `notTargetedCountryCount` складывается из двух источников: страны,
    // по которым решения нет вообще, и страны, решение по которым — «рынок не обслуживается».
    // Первые отдаются отдельно как `undecidedCountryCount`: для редактора это разные вещи —
    // осознанно исключённый рынок закрывать нечем, а непроверенную страну надо проверить.
    const targetedCount = decisions.length - notTargetedDecisionCount;
    const undecidedCount = Math.max(0, totalCountryCount - decisions.length);
    const notTargetedCount = Math.max(0, totalCountryCount - targetedCount);

    let status: RegionalRightsStatus;
    if (targetedCount === 0) {
      status = 'NOT_TARGETED';
    } else if (allowedCount === targetedCount && undecidedCount === 0) {
      // WP-10.5 (R6-04): зелёный ярлык означает «весь регион разрешён». Раньше статус
      // считался только по странам с решением, поэтому ЕС с тремя проверенными странами
      // из 27 отдавался как ALLOWED — публикация в остальных 24 при этом ничем
      // не ограничена. Непроверенная страна разрешением не является.
      status = 'ALLOWED';
    } else if (blockedCount === targetedCount) {
      status = 'BLOCKED';
    } else if (licenseRequiredCount === targetedCount) {
      status = 'LICENSE_REQUIRED';
    } else if (pendingCount === targetedCount) {
      status = 'PENDING_REVIEW';
    } else {
      status = 'MIXED';
    }

    return {
      regionCode,
      label,
      status,
      countryCount: totalCountryCount,
      targetedCountryCount: targetedCount,
      allowedCountryCount: allowedCount,
      licensedCountryCount: licensedCount,
      blockedCountryCount: blockedCount,
      licenseRequiredCountryCount: licenseRequiredCount,
      pendingReviewCountryCount: pendingCount,
      notTargetedCountryCount: notTargetedCount,
      undecidedCountryCount: undecidedCount,
      geoBlockRequiredCount: geoBlockCount,
      countries: countriesDto,
      blockingReasons: blockingReasonsDto,
    };
  }

  private toIsoDate(value: unknown): string | null {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    if (typeof value === 'string' || typeof value === 'number') {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }
    return null;
  }
}
