#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

// Script to check production configuration
const fs = require('fs');
const path = require('path');

console.log('🔍 Checking production configuration');
console.log('==================================\n');

// Load .env.prod
const envPath = path.join(__dirname, '.env.prod');
if (!fs.existsSync(envPath)) {
  console.error('❌ .env.prod file not found');
  process.exit(1);
}

const envContent = fs.readFileSync(envPath, 'utf8');
const envVars = {};

// Parse .env file
envContent.split('\n').forEach((line) => {
  const match = line.match(/^([^#][^=]*)=(.*)$/);
  if (match) {
    envVars[match[1].trim()] = match[2].trim();
  }
});

// Check critical settings
const checks = [
  {
    name: 'NODE_ENV',
    expected: 'production',
    actual: envVars.NODE_ENV,
    critical: true,
  },
  {
    name: 'SWAGGER_ENABLED',
    expected: '0',
    actual: envVars.SWAGGER_ENABLED,
    critical: true,
  },
  {
    name: 'RATE_LIMIT_GLOBAL_ENABLED',
    expected: '1',
    actual: envVars.RATE_LIMIT_GLOBAL_ENABLED,
    critical: true,
  },
  {
    name: 'TRUST_PROXY',
    expected: '1',
    actual: envVars.TRUST_PROXY,
    critical: true,
  },
  {
    name: 'JWT_ACCESS_SECRET',
    expected: 'exists',
    actual: envVars.JWT_ACCESS_SECRET ? 'exists' : 'missing',
    critical: true,
  },
  {
    name: 'JWT_REFRESH_SECRET',
    expected: 'exists',
    actual: envVars.JWT_REFRESH_SECRET ? 'exists' : 'missing',
    critical: true,
  },
  {
    name: 'DATABASE_URL',
    expected: 'exists',
    actual: envVars.DATABASE_URL ? 'exists' : 'missing',
    critical: true,
  },
  {
    name: 'DEFAULT_LANGUAGE',
    expected: 'en',
    actual: envVars.DEFAULT_LANGUAGE,
    critical: false,
  },
];

let allPassed = true;

checks.forEach((check) => {
  const passed = check.actual === check.expected;
  const icon = passed ? '✅' : check.critical ? '❌' : '⚠️';
  const status = passed ? 'OK' : 'FAIL';

  console.log(`${icon} ${check.name}: ${check.actual} (${status})`);

  if (!passed && check.critical) {
    allPassed = false;
  }
});

console.log('\n📊 Additional information:');

// Check JWT secrets length
if (envVars.JWT_ACCESS_SECRET) {
  const length = envVars.JWT_ACCESS_SECRET.length;
  console.log(`🔑 JWT_ACCESS_SECRET length: ${length} characters ${length >= 32 ? '✅' : '⚠️'}`);
}

if (envVars.JWT_REFRESH_SECRET) {
  const length = envVars.JWT_REFRESH_SECRET.length;
  console.log(`🔑 JWT_REFRESH_SECRET length: ${length} characters ${length >= 32 ? '✅' : '⚠️'}`);
}

// Check DATABASE_URL format
if (envVars.DATABASE_URL) {
  const urlStr = envVars.DATABASE_URL;
  const isPostgres = urlStr.startsWith('postgresql://') || urlStr.startsWith('postgres://');
  console.log(`🗄️  DATABASE_URL format: ${isPostgres ? 'PostgreSQL ✅' : 'Unknown ⚠️'}`);
  try {
    const u = new URL(String(urlStr));
    const port = u.port || '5432';
    const portOk = /^\d+$/.test(port);
    console.log(`🔌 DATABASE_URL port: ${port} ${portOk ? '✅' : '❌'}`);
    if (!portOk) {
      console.error(
        '   ↳ Port must be a number. Ensure you are not using variables in the URL (e.g., ${POSTGRES_PORT}) and there are no comments in the line.',
      );
    }
    if (u.password && /[@/:]/.test(decodeURIComponent(u.password))) {
      console.log(
        '🔐 DATABASE_URL password: contains special characters — ensure it is URL-encoded (%2F, %40, %3A, %3D, etc.) ⚠️',
      );
    }
  } catch {
    console.error('❌ DATABASE_URL: invalid URL, failed to parse');
  }
}

// Check docker-compose.prod.yml file
const dockerComposePath = path.join(__dirname, 'docker-compose.prod.yml');
if (fs.existsSync(dockerComposePath)) {
  const composeContent = fs.readFileSync(dockerComposePath, 'utf8');
  const usesEnvProd = composeContent.includes('.env.prod');
  const hasHealthcheck = composeContent.includes('/api/metrics');

  console.log(`🐳 docker-compose.prod.yml uses .env.prod: ${usesEnvProd ? '✅' : '❌'}`);
  console.log(
    `🩺 docker-compose.prod.yml healthcheck path: ${hasHealthcheck ? '/api/metrics ✅' : 'Wrong path ❌'}`,
  );
} else {
  console.log('🐳 docker-compose.prod.yml: ❌ Not found');
  allPassed = false;
}

console.log('\n' + '='.repeat(50));

if (allPassed) {
  console.log('🎉 All critical settings are correct!');
  console.log('✅ Ready for production deployment');
} else {
  console.log('❌ There are critical configuration issues');
  console.log('🔧 Fix errors before deployment');
  process.exit(1);
}
