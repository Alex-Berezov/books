import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ClientIpRequest,
  isFromInternalProxy,
  parseInternalProxyCidrs,
  parseTrustedProxyCidrs,
  VISITOR_COUNTRY_HEADER,
} from '../../common/net/client-ip';
import { TRUSTED_VISITOR_COUNTRY } from './geo-ip-country.service';

type VisitorCountryRequest = ClientIpRequest & {
  headers: Record<string | symbol, string | string[] | undefined>;
};

/**
 * LEGACY-465. `X-Visitor-Country` is stripped from every request; the country moves under the
 * `TRUSTED_VISITOR_COUNTRY` key only for a request from our own front (`isFromInternalProxy`).
 * `GeoIpCountryService` reads the key, never the header, so without this middleware the header is
 * not trusted at all: the failure is closed, not open. Node joins a repeated header into one
 * string (`'de, us'`), which the service then rejects as an unknown country.
 */
@Injectable()
export class VisitorCountryMiddleware implements NestMiddleware {
  private readonly trustedCidrs: string[];
  private readonly internalCidrs: string[];

  constructor(config: ConfigService) {
    this.trustedCidrs = parseTrustedProxyCidrs(config.get<string>('TRUSTED_PROXY_CIDRS'));
    this.internalCidrs = parseInternalProxyCidrs(config.get<string>('INTERNAL_PROXY_CIDRS'));
  }

  use(req: VisitorCountryRequest, _res: unknown, next: () => void): void {
    const raw = req.headers[VISITOR_COUNTRY_HEADER];
    if (raw !== undefined) {
      delete req.headers[VISITOR_COUNTRY_HEADER];
      if (isFromInternalProxy(req, this.trustedCidrs, this.internalCidrs)) {
        req.headers[TRUSTED_VISITOR_COUNTRY] = Array.isArray(raw) ? raw[0] : raw;
      }
    }
    next();
  }
}
