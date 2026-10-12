import { Controller, Get, Headers, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../../prisma/prisma.service';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { GeoBlockModule } from './geo-block.module';
import {
  GeoIpCountryService,
  GeoRequestHeaders,
  TRUSTED_VISITOR_COUNTRY,
} from './geo-ip-country.service';
import { VisitorCountryMiddleware } from './visitor-country.middleware';

/**
 * LEGACY-465. `X-Visitor-Country` is trusted only from our own front: the peer is Cloudflare and
 * `CF-Connecting-IP` is an address from `INTERNAL_PROXY_CIDRS`. From any other source the header is
 * stripped and the country comes from `cf-ipcountry` as before.
 */
const CF_PEER = '104.21.3.171'; // within 104.16.0.0/13
const FRONT = '10.0.0.5';
const STRANGER = '203.0.113.7';

type MiddlewareRequest = Parameters<VisitorCountryMiddleware['use']>[0];

const middlewareWith = (values: Record<string, string | undefined>) =>
  new VisitorCountryMiddleware({
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService);

const run = (middleware: VisitorCountryMiddleware, req: MiddlewareRequest) => {
  const next = jest.fn();
  middleware.use(req, undefined, next);
  expect(next).toHaveBeenCalledTimes(1);
  return req.headers;
};

describe('VisitorCountryMiddleware (LEGACY-465)', () => {
  const internal = { INTERNAL_PROXY_CIDRS: `${FRONT}/32` };

  it('moves the country under the trusted key for a request from the front', () => {
    const headers = run(middlewareWith(internal), {
      ip: CF_PEER,
      headers: { 'cf-connecting-ip': FRONT, 'x-visitor-country': 'de' },
    });

    expect(headers[TRUSTED_VISITOR_COUNTRY]).toBe('de');
    expect(headers['x-visitor-country']).toBeUndefined();
  });

  it.each([[''], [[]]])('keeps an empty value %j from the front as present', (value) => {
    const headers = run(middlewareWith(internal), {
      ip: CF_PEER,
      headers: { 'cf-connecting-ip': FRONT, 'x-visitor-country': value as string | string[] },
    });

    expect(TRUSTED_VISITOR_COUNTRY in headers).toBe(true);
  });

  it.each([
    ['a visitor behind Cloudflare', { ip: CF_PEER, cf: STRANGER, env: internal }],
    ['the front address without Cloudflare as the peer', { ip: FRONT, cf: FRONT, env: internal }],
    ['a stranger naming the front in CF-Connecting-IP', { ip: STRANGER, cf: FRONT, env: internal }],
    ['the front when INTERNAL_PROXY_CIDRS is empty', { ip: CF_PEER, cf: FRONT, env: {} }],
    ['the front with a malformed CF-Connecting-IP', { ip: CF_PEER, cf: 'front', env: internal }],
  ])('strips the header from %s', (_name, { ip, cf, env }) => {
    const headers = run(middlewareWith(env), {
      ip,
      headers: { 'cf-connecting-ip': cf, 'x-visitor-country': 'de' },
    });

    expect(TRUSTED_VISITOR_COUNTRY in headers).toBe(false);
    expect(headers['x-visitor-country']).toBeUndefined();
  });

  it('trims CF-Connecting-IP and keeps a joined repeated header as one value', () => {
    // Node joins a repeated custom header into one string; the service rejects it as unknown.
    const headers = run(middlewareWith(internal), {
      ip: CF_PEER,
      headers: { 'cf-connecting-ip': ` ${FRONT} `, 'x-visitor-country': 'de, us' },
    });

    expect(headers[TRUSTED_VISITOR_COUNTRY]).toBe('de, us');
    expect(headers['x-visitor-country']).toBeUndefined();
  });

  it('leaves a request without the header untouched', () => {
    const headers = run(middlewareWith(internal), {
      ip: CF_PEER,
      headers: { 'cf-connecting-ip': FRONT },
    });

    expect(TRUSTED_VISITOR_COUNTRY in headers).toBe(false);
  });
});

@Controller('probe')
class CountryProbeController {
  constructor(private readonly geo: GeoIpCountryService) {}

  @Get()
  country(@Headers() headers: GeoRequestHeaders) {
    return { country: this.geo.resolveCountry(headers) };
  }
}

@Module({ imports: [GeoBlockModule], controllers: [CountryProbeController] })
class ProbeModule {}

/**
 * Wiring: the middleware hangs on every route via `GeoBlockModule.configure`; the app is built as in
 * `main.ts` — the `/api` prefix and `trust proxy`.
 */
describe('GeoBlockModule wires VisitorCountryMiddleware (LEGACY-465)', () => {
  let app: NestExpressApplication;
  const probe = () =>
    request(app.getHttpServer()).get('/api/probe').set('x-forwarded-for', CF_PEER);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              NODE_ENV: 'production',
              INTERNAL_PROXY_CIDRS: `${FRONT}/32`,
            }),
          ],
        }),
        ProbeModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    // As in `main.ts` with `TRUST_PROXY=1`: `req.ip` is the last `X-Forwarded-For` address, set by
    // Caddy — the Cloudflare node. The Cloudflare list is the default one.
    app.set('trust proxy', 1);
    // As in `main.ts`: routes live under `/api`, otherwise prefixed paths are not covered.
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('takes the country from the front over cf-ipcountry', async () => {
    const res = await probe()
      .set('cf-connecting-ip', FRONT)
      .set('cf-ipcountry', 'US')
      .set('x-visitor-country', 'DE')
      .expect(200);

    expect(res.body).toEqual({ country: 'DE' });
  });

  it('does not fall back to cf-ipcountry when the front sends no country', async () => {
    const res = await probe()
      .set('cf-connecting-ip', FRONT)
      .set('cf-ipcountry', 'US')
      .set('x-visitor-country', 'XX')
      .expect(200);

    expect(res.body).toEqual({ country: null });
  });

  it('ignores the header from anyone else', async () => {
    const res = await probe()
      .set('cf-connecting-ip', STRANGER)
      .set('cf-ipcountry', 'US')
      .set('x-visitor-country', 'DE')
      .expect(200);

    expect(res.body).toEqual({ country: 'US' });
  });
});
