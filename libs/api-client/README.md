# API Client (generated types)

This folder is intended to host generated TypeScript types (or SDK) from the backend OpenAPI spec.

Commands:

- yarn openapi:types — generates TypeScript types to libs/api-client/types.ts from /api/docs-json
- yarn openapi:types:prod — same but targets production URL (override with OPENAPI_URL)

Notes:

- Keep this folder committed so FE can consume generated types or copy them into its repo.
- If you want a full SDK (fetch client), consider adding openapi-generator-cli or orval.

Next.js + RTK Query tip:

- If you prefer RTK Query, use these types for endpoints and write typed baseQuery (fetch/axios). Or generate an SDK with orval and wrap it into RTK Query endpoints.
