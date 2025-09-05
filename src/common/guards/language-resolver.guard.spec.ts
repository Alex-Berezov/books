import { LanguageResolverGuard } from './language-resolver.guard';
import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { Language } from '@prisma/client';

type MockRequest = {
  language?: Language;
  params?: Record<string, string>;
  query?: Record<string, any>;
  headers?: Record<string, any>;
};

function createContext(mock: {
  params?: Record<string, string>;
  query?: Record<string, any>;
  headers?: Record<string, any>;
}): { ctx: ExecutionContext; req: MockRequest } {
  const req: MockRequest = {
    params: mock.params || {},
    query: mock.query || {},
    headers: mock.headers || {},
  };
  const ctx = {
    switchToHttp: () => ({ getRequest: <T = unknown>() => req as unknown as T }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

describe('LanguageResolverGuard', () => {
  let guard: LanguageResolverGuard;

  beforeEach(() => {
    guard = new LanguageResolverGuard(new Reflector());
    process.env.DEFAULT_LANGUAGE = 'en';
  });

  it('uses :lang param when valid', () => {
    const { ctx, req } = createContext({ params: { lang: 'fr' } });
    expect(guard.canActivate(ctx)).toBe(true);
    expect(req.language).toBe('fr');
  });

  it('falls back to query ?lang when param is missing/invalid', () => {
    const { ctx, req } = createContext({
      params: { lang: 'zz' },
      query: { lang: 'es' },
    });
    guard.canActivate(ctx);
    expect(req.language).toBe('es');
  });

  it('uses Accept-Language when path and query absent/invalid', () => {
    const { ctx, req } = createContext({ headers: { 'accept-language': 'pt-BR, fr;q=0.5' } });
    guard.canActivate(ctx);
    // pt from pt-BR
    expect(req.language).toBe('pt');
  });

  it('uses default when nothing matches', () => {
    process.env.DEFAULT_LANGUAGE = 'fr';
    const { ctx, req } = createContext({ headers: { 'accept-language': 'zz, xx' } });
    guard.canActivate(ctx);
    expect(req.language).toBe('fr');
  });

  it('rejects unsupported values even if present', () => {
    const { ctx, req } = createContext({
      params: { lang: 'xx' },
      query: { lang: 'yy' },
      headers: { 'accept-language': 'zz' },
    });
    guard.canActivate(ctx);
    // should be default to a supported value
    expect(new Set(Object.values(Language)).has(req.language as Language)).toBe(true);
  });
});
