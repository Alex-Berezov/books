import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * CORS Configuration for the API
 *
 * Configures Cross-Origin Resource Sharing for interaction with frontend applications.
 *
 * Environment Variables:
 * - CORS_ORIGIN: Allowed origins (comma-separated). Default: '*'
 * - CORS_CREDENTIALS: Allow cookies/credentials (0 or 1). Default: 0
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

  // If wildcard '*' is present, use simple CORS
  if (allowedOrigins.includes('*')) {
    return {
      origin: '*',
      credentials: false, // credentials do not work with a wildcard origin
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Language', 'Accept-Language'],
    };
  }

  // For specific origins use a function-based check
  return {
    origin: (origin, callback) => {
      // Allow requests without Origin (e.g., server-to-server or curl)
      if (!origin) {
        callback(null, true);
        return;
      }

      // Verify Origin is whitelisted
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
    maxAge: 86400, // 24 hours - cache preflight requests
  };
}

/**
 * Inspect current CORS configuration.
 *
 * @returns Information about the current CORS configuration.
 */
export function getCorsConfigInfo() {
  const corsOrigin = process.env.CORS_ORIGIN || '*';
  const corsCredentials = process.env.CORS_CREDENTIALS === '1';

  return {
    origins: corsOrigin === '*' ? ['*'] : corsOrigin.split(',').map((s) => s.trim()),
    credentials: corsCredentials,
    warning:
      corsOrigin === '*' && corsCredentials
        ? 'CORS credentials do not work with wildcard origin (*). Use explicit domains.'
        : null,
  };
}
