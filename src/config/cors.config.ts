import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * CORS Configuration для API
 *
 * Настраивает Cross-Origin Resource Sharing для работы с фронтенд-приложениями
 *
 * Environment Variables:
 * - CORS_ORIGIN: Разрешенные origins (через запятую). По умолчанию: '*'
 * - CORS_CREDENTIALS: Разрешить cookies/credentials (0 или 1). По умолчанию: 0
 *
 * @example
 * # Production
 * CORS_ORIGIN=https://bibliaris.com,https://app.bibliaris.com
 * CORS_CREDENTIALS=1
 *
 * # Development
 * CORS_ORIGIN=http://localhost:3000,http://localhost:3001
 * CORS_CREDENTIALS=1
 */
export function getCorsConfig(): CorsOptions {
  const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim())
    : ['*'];

  const allowCredentials = process.env.CORS_CREDENTIALS === '1';

  // Если указан wildcard, используем simple CORS
  if (allowedOrigins.includes('*')) {
    return {
      origin: '*',
      credentials: false, // credentials не работает с wildcard origin
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Language', 'Accept-Language'],
    };
  }

  // Для конкретных origins используем функцию для проверки
  return {
    origin: (origin, callback) => {
      // Разрешаем запросы без Origin (например, server-to-server или curl)
      if (!origin) {
        callback(null, true);
        return;
      }

      // Проверяем, что Origin в whitelist
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn(`[CORS] Blocked request from origin: ${origin}`);
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: allowCredentials,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Admin-Language',
      'Accept-Language',
      'Accept',
      'Origin',
      'X-Requested-With',
    ],
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    maxAge: 86400, // 24 hours - кэширование preflight запросов
  };
}

/**
 * Проверка корректности CORS конфигурации
 *
 * @returns Информация о текущей конфигурации CORS
 */
export function getCorsConfigInfo() {
  const corsOrigin = process.env.CORS_ORIGIN || '*';
  const corsCredentials = process.env.CORS_CREDENTIALS === '1';

  return {
    origins: corsOrigin === '*' ? ['*'] : corsOrigin.split(',').map((s) => s.trim()),
    credentials: corsCredentials,
    warning:
      corsOrigin === '*' && corsCredentials
        ? 'CORS credentials не работает с wildcard origin (*). Используйте конкретные домены.'
        : null,
  };
}
