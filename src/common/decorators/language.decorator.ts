import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Language as PrismaLanguage } from '@prisma/client';
import { getDefaultLanguage } from '../../shared/language/language.util';

export const Language = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PrismaLanguage => {
    const req = ctx.switchToHttp().getRequest<{ language?: PrismaLanguage }>();
    return req.language ?? getDefaultLanguage();
  },
);
