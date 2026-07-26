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

@Injectable()
export class TerritoryRegionAggregationService {
  aggregateTerritoryDecisions(decisions: Array<Record<string, any>>): TerritoryRegionSummaryDto[] {
    if (!decisions || decisions.length === 0) {
      return FIXED_REGIONS.map((r) =>
        this.createEmptyRegionSummary(r.regionCode, r.label, r.countryCodes.length),
      );
    }

    const decisionMap = new Map<string, Record<string, any>>();
    for (const d of decisions) {
      if (d && typeof d.countryCode === 'string') {
        decisionMap.set(d.countryCode.toUpperCase(), d);
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
      const regionDecisions: Array<Record<string, any>> = [];
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
    const otherDecisions: Array<Record<string, any>> = [];
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
      blockedCountryCount: 0,
      licenseRequiredCountryCount: 0,
      pendingReviewCountryCount: 0,
      notTargetedCountryCount: countryCount,
      geoBlockRequiredCount: 0,
      countries: [],
      blockingReasons: [],
    };
  }

  private buildRegionSummary(
    regionCode: string,
    label: string,
    totalCountryCount: number,
    decisions: Array<Record<string, any>>,
  ): TerritoryRegionSummaryDto {
    if (decisions.length === 0) {
      return this.createEmptyRegionSummary(regionCode, label, totalCountryCount);
    }

    let allowedCount = 0;
    let blockedCount = 0;
    let licenseRequiredCount = 0;
    let pendingCount = 0;
    let geoBlockCount = 0;

    const countriesDto: TerritoryRegionCountryDto[] = [];
    const blockingReasonsDto: TerritoryRegionReasonDto[] = [];

    for (const d of decisions) {
      const countryCode = String(d.countryCode).toUpperCase();
      const finalStatus = String(d.finalStatus || 'PENDING_REVIEW').toUpperCase();
      const accessPolicy = String(d.accessPolicy || 'REVIEW_REQUIRED').toUpperCase();
      const geoBlockRequired = Boolean(d.geoBlockRequired);

      if (geoBlockRequired) {
        geoBlockCount++;
      }

      const isAllowed =
        finalStatus === 'PUBLIC_DOMAIN' ||
        finalStatus === 'ALLOWED' ||
        (finalStatus === 'ALLOWED_AFTER_CHANGES' && accessPolicy !== 'BLOCK');

      const isBlocked = finalStatus === 'BLOCKED' || accessPolicy === 'BLOCK';
      const isLicenseRequired = finalStatus === 'LICENSE_REQUIRED';
      const isPending =
        finalStatus === 'PENDING_REVIEW' ||
        finalStatus === 'NOT_CHECKED' ||
        finalStatus === 'UNCERTAIN';

      if (isBlocked) {
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
        geoBlockScope: (d.geoBlockScope as string | null) || null,
        reasonRu: String(d.reasonRu || ''),
        legalBasisRu: (d.legalBasisRu as string | null) || null,
        confidence: String(d.confidence || 'MEDIUM'),
        nextReviewAt: d.nextReviewAt ? new Date(d.nextReviewAt).toISOString() : null,
      });

      if (!isAllowed) {
        blockingReasonsDto.push({
          countryCode,
          finalStatus,
          accessPolicy,
          reasonRu: String(d.reasonRu || ''),
          legalBasisRu: (d.legalBasisRu as string | null) || null,
        });
      }
    }

    const targetedCount = decisions.length;
    const notTargetedCount = Math.max(0, totalCountryCount - targetedCount);

    let status: RegionalRightsStatus = 'MIXED';
    if (allowedCount === targetedCount) {
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
      blockedCountryCount: blockedCount,
      licenseRequiredCountryCount: licenseRequiredCount,
      pendingReviewCountryCount: pendingCount,
      notTargetedCountryCount: notTargetedCount,
      geoBlockRequiredCount: geoBlockCount,
      countries: countriesDto,
      blockingReasons: blockingReasonsDto,
    };
  }
}
