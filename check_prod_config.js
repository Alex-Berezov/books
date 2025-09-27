#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

// Скрипт для проверки конфигурации продакшна
const fs = require('fs');
const path = require('path');

console.log('🔍 Проверка конфигурации продакшна');
console.log('==================================\n');

// Загрузить .env.prod
const envPath = path.join(__dirname, '.env.prod');
if (!fs.existsSync(envPath)) {
  console.error('❌ Файл .env.prod не найден');
  process.exit(1);
}

const envContent = fs.readFileSync(envPath, 'utf8');
const envVars = {};

// Парсить .env файл
envContent.split('\n').forEach((line) => {
  const match = line.match(/^([^#][^=]*)=(.*)$/);
  if (match) {
    envVars[match[1].trim()] = match[2].trim();
  }
});

// Проверить критические настройки
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

console.log('\n📊 Дополнительная информация:');

// Проверить длину JWT секретов
if (envVars.JWT_ACCESS_SECRET) {
  const length = envVars.JWT_ACCESS_SECRET.length;
  console.log(`🔑 JWT_ACCESS_SECRET length: ${length} символов ${length >= 32 ? '✅' : '⚠️'}`);
}

if (envVars.JWT_REFRESH_SECRET) {
  const length = envVars.JWT_REFRESH_SECRET.length;
  console.log(`🔑 JWT_REFRESH_SECRET length: ${length} символов ${length >= 32 ? '✅' : '⚠️'}`);
}

// Проверить DATABASE_URL format
if (envVars.DATABASE_URL) {
  const isPostgres = envVars.DATABASE_URL.startsWith('postgresql://');
  console.log(`🗄️  DATABASE_URL format: ${isPostgres ? 'PostgreSQL ✅' : 'Unknown ⚠️'}`);
}

// Проверить файл docker-compose.prod.yml
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
  console.log('🎉 Все критические настройки корректны!');
  console.log('✅ Готов к развертыванию в продакшене');
} else {
  console.log('❌ Есть критические проблемы конфигурации');
  console.log('🔧 Исправьте ошибки перед развертыванием');
  process.exit(1);
}
