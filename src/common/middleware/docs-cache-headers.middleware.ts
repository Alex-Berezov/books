import type { NextFunction, Request, Response } from 'express';
import { PRIVATE_NO_STORE } from '../interceptors/cache-control';

// `/docs-yaml` Swagger поднимает сам (`raw` по умолчанию `true`) — та же схема.
const DOCS_PATHS = ['/docs', '/docs-json', '/docs-yaml'];

/**
 * `LEGACY-108` (остаток `T37`). `SwaggerModule.setup('docs', ...)` монтирует
 * `/docs`, `/docs-json` и `/docs-yaml` на Express **до** `app.setGlobalPrefix('api')`
 * (`main.ts`), поэтому они лежат вне `/api`, на который матчится
 * `DefaultCacheControlMiddleware`, и уходили без единой директивы
 * `Cache-Control` — эвристически кешируемый ответ по RFC 9111 §4.2.2.
 *
 * 🔴 Подключается в `main.ts` через `app.use(...)` **до** `SwaggerModule.setup`:
 * Express исполняет стек по порядку, и маршрут Swagger, стоящий раньше, отдал бы
 * ответ до этой функции. `MiddlewareConsumer.forRoutes` сюда не достаёт.
 *
 * Путь сравнивается без учёта регистра: маршрутизация Express регистр
 * не различает (`case sensitive routing` выключена), и `/Docs-Json` отдаёт
 * ту же схему — так же разобран `rights-allow-list.ts`.
 *
 * Публичность самих адресов не меняется — это тема владельца, здесь только
 * заголовок.
 */
export function docsCacheHeadersMiddleware(req: Request, res: Response, next: NextFunction): void {
  const path = (req.path || req.url || '').toLowerCase();
  const isDocsRoute = DOCS_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

  if (isDocsRoute) {
    res.setHeader('Cache-Control', PRIVATE_NO_STORE);
  }

  next();
}
