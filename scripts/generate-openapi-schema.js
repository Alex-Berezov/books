#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

/**
 * Скрипт для скачивания OpenAPI JSON схемы с API
 *
 * Usage:
 *   node scripts/generate-openapi-schema.js [URL]
 *
 * Examples:
 *   node scripts/generate-openapi-schema.js
 *   node scripts/generate-openapi-schema.js http://localhost:5000/api/docs-json
 *   node scripts/generate-openapi-schema.js https://api.bibliaris.com/api/docs-json
 *
 * Saves to: libs/api-client/api-schema.json
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const url = process.argv[2] || 'http://localhost:5000/api/docs-json';
const outputDir = path.join(__dirname, '../libs/api-client');
const outputFile = path.join(outputDir, 'api-schema.json');

console.log(`📥 Fetching OpenAPI schema from ${url}...`);

const client = url.startsWith('https') ? https : http;

client
  .get(url, (res) => {
    let data = '';

    if (res.statusCode !== 200) {
      console.error(`❌ Failed to fetch schema: HTTP ${res.statusCode}`);
      console.error(`   Make sure the API server is running and Swagger is enabled.`);
      process.exit(1);
    }

    res.on('data', (chunk) => {
      data += chunk;
    });

    res.on('end', () => {
      try {
        // Проверяем, что получили валидный JSON
        const json = JSON.parse(data);

        // Создаем директорию если не существует
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }

        // Сохраняем с красивым форматированием
        fs.writeFileSync(outputFile, JSON.stringify(json, null, 2), 'utf8');

        console.log(`✅ OpenAPI schema saved to: ${outputFile}`);
        console.log(`   Schema version: ${json.info?.version || 'unknown'}`);
        console.log(`   API title: ${json.info?.title || 'unknown'}`);
        console.log(`   Endpoints: ${Object.keys(json.paths || {}).length}`);
        console.log('');
        console.log('Next step: Run yarn openapi:types to generate TypeScript types');
      } catch (error) {
        console.error(`❌ Failed to parse JSON response:`);
        console.error(`   ${error.message}`);
        console.error('');
        console.error('Response preview:');
        console.error(data.substring(0, 500));
        process.exit(1);
      }
    });
  })
  .on('error', (error) => {
    console.error(`❌ Network error:`);
    console.error(`   ${error.message}`);
    console.error('');
    console.error('Troubleshooting:');
    console.error('  - Check that the API server is running');
    console.error('  - Verify the URL is correct');
    console.error('  - For localhost, make sure the port matches');
    console.error('  - For production, check firewall/SSL settings');
    process.exit(1);
  });
