import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Language } from '@prisma/client';
import { getDefaultLanguage, parseAcceptLanguage } from '../../shared/language/language.util';

declare module 'http' {
  interface IncomingMessage {
    language?: Language;
  }
}

@Injectable()
export class LanguageResolverGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<
      Request & {
        language?: Language;
        params?: Record<string, string>;
        query?: Record<string, any>;
      }
    >();

    // Priority: path param > query > Accept-Language > default
    const params: Record<string, string | undefined> = req.params || {};
    const query: Record<string, string | undefined> = (req.query as Record<string, string>) || {};
    const header = (req.headers?.['accept-language'] as string | undefined) || undefined;

    const normalize = (v?: string) => (v ? (v.toLowerCase() as Language) : undefined);
    const supported = new Set<string>(Object.values(Language));
    const fromParam = normalize(params['lang']);
    if (fromParam && supported.has(fromParam)) {
      req.language = fromParam;
      return true;
    }

    const fromQuery = normalize(query['lang']);
    if (fromQuery && supported.has(fromQuery)) {
      req.language = fromQuery;
      return true;
    }

    for (const tag of parseAcceptLanguage(header)) {
      const t = normalize(tag);
      if (t && supported.has(t)) {
        req.language = t;
        return true;
      }
    }

    req.language = getDefaultLanguage();
    return true;
  }
}
