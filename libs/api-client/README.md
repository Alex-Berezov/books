# API Client Types for Frontend

Auto-generated TypeScript types from backend API OpenAPI specification.

## 📦 What's Inside

- `types.ts` - TypeScript types for all API endpoints (auto-generated)
- `api-schema.json` - OpenAPI JSON schema (optional, for caching)
- `.gitignore` - excludes generated files from Git (if configured)

## 🚀 Frontend Usage

### 1. Generate Types

```bash
# In the backend project root

# Option A: Generate from local API (dev server must be running)
yarn openapi:types

# Option B: Generate from production API
yarn openapi:types:prod

# Option C: Download schema first, then generate types
yarn openapi:schema        # or yarn openapi:schema:prod
yarn openapi:types:from-schema
```

### 2. Copy to Frontend Project

```bash
# From backend project root
cp libs/api-client/types.ts ../frontend/src/types/api.ts
```

Or create an npm script in your frontend:

```json
{
  "scripts": {
    "api:types:update": "cp ../books-app-back/libs/api-client/types.ts ./src/types/api.ts"
  }
}
```

### 3. Use in Code

```typescript
import { paths, components } from '@/types/api';

// Типы для endpoints
type LoginResponse =
  paths['/api/auth/login']['post']['responses']['200']['content']['application/json'];

type BookDTO = components['schemas']['BookDto'];
type UserDTO = components['schemas']['UserDto'];

// Example with fetch
const login = async (email: string, password: string): Promise<LoginResponse> => {
  const response = await fetch('https://api.bibliaris.com/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    throw new Error(`Login failed: ${response.status}`);
  }

  return response.json();
};
```

## 🔄 Automatic Type Updates

### In Frontend CI/CD

Add a type update step to GitHub Actions:

```yaml
name: Update API Types

on:
  schedule:
    - cron: '0 2 * * *' # Every day at 2:00 AM
  workflow_dispatch: # Manual trigger

jobs:
  update-types:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Generate API types
        run: |
          npx openapi-typescript https://api.bibliaris.com/api/docs-json -o src/types/api.ts

      - name: Create Pull Request
        uses: peter-evans/create-pull-request@v5
        with:
          commit-message: 'chore: update API types'
          title: 'Update API types from production'
          branch: 'update-api-types'
```

## 📚 Additional Tools

### RTK Query Code Generation

If using Redux Toolkit Query:

```bash
# Installation
yarn add -D @rtk-query/codegen-openapi

# Configuration: rtk-query-codegen.config.ts
import type { ConfigFile } from '@rtk-query/codegen-openapi';

const config: ConfigFile = {
  schemaFile: 'https://api.bibliaris.com/api/docs-json',
  apiFile: './src/store/emptyApi.ts',
  apiImport: 'emptySplitApi',
  outputFile: './src/store/api.ts',
  exportName: 'api',
  hooks: true,
};

export default config;

# Generation
yarn rtk-query-codegen rtk-query-codegen.config.ts
```

### React Query / TanStack Query

```typescript
// src/lib/api-client.ts
import { paths } from '@/types/api';

type ApiPath = keyof paths;
type ApiMethod<P extends ApiPath> = keyof paths[P];

export async function apiRequest<P extends ApiPath, M extends ApiMethod<P>>(
  path: P,
  method: M,
  options?: RequestInit,
) {
  const response = await fetch(`https://api.bibliaris.com${path}`, {
    method: method.toString().toUpperCase(),
    ...options,
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}
```

## 🔗 Useful Links

- **Production API**: https://api.bibliaris.com
- **Swagger UI**: https://api.bibliaris.com/docs
- **OpenAPI JSON**: https://api.bibliaris.com/api/docs-json
- **Health Check**: https://api.bibliaris.com/api/health/liveness

## 📖 API Documentation

Complete documentation for frontend integration:

- [Frontend Integration Guide](../../docs/FRONTEND_INTEGRATION.md)
- [API Examples](../../docs/examples/frontend-examples.ts)

## 🛠️ Troubleshooting

### Error: "Cannot find module '@/types/api'"

Make sure:

1. Types are generated: `yarn openapi:types` (in backend)
2. File is copied to frontend project
3. TypeScript alias `@` is configured in `tsconfig.json`

### Error: "Error fetching schema"

Check:

1. API server is running (for local generation)
2. `/docs-json` endpoint is accessible (Swagger is always enabled)
3. Production URL is accessible (for prod generation)
