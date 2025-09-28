# Books App API Client - Frontend Integration Guide

This package provides a TypeScript SDK for integrating with the Books App backend API.

## Installation

### Option 1: Copy to your project

```bash
cp -r libs/api-client path/to/your/frontend/src/api-client
```

### Option 2: Use as local package

```bash
cd libs/api-client
yarn pack
# Then in your frontend project
yarn add file:path/to/books-app-api-client-v1.0.0.tgz
```

## Quick Start

```typescript
import { BooksApiClient } from './api-client';

// Initialize the client
const api = new BooksApiClient({
  baseURL: 'https://your-api-domain.com', // or http://localhost:5000 for dev
  timeout: 30000,
});

// Authentication
try {
  const tokens = await api.login({
    email: 'user@example.com',
    password: 'password123',
  });
  console.log('Logged in successfully:', tokens);
} catch (error) {
  console.error('Login failed:', error);
}

// Fetch books
const books = await api.books.getAll({ limit: 10 });
console.log('Books:', books);

// Get book overview
const bookOverview = await api.books.getOverview('book-slug', 'en');
console.log('Book overview:', bookOverview);
```

## Authentication

The client automatically handles:

- JWT token storage and usage
- Token refresh when expired
- Automatic retry of failed requests after token refresh

```typescript
// Login
const tokens = await api.login({ email, password });

// Register
const tokens = await api.register({
  email,
  password,
  firstName: 'John',
  lastName: 'Doe',
});

// Logout
await api.logout();

// Manual token management
api.setAccessToken('your-jwt-token');
api.clearTokens();
```

## API Methods

### Books

```typescript
// Get all books with pagination
const books = await api.books.getAll({
  limit: 20,
  offset: 0,
  language: 'en',
});

// Get book by ID
const book = await api.books.getById('book-id');

// Get book by slug
const book = await api.books.getBySlug('book-slug');

// Get book overview (optimized for frontend)
const overview = await api.books.getOverview('book-slug', 'en');

// Create, update, delete (requires appropriate permissions)
const newBook = await api.books.create(bookData);
const updatedBook = await api.books.update('book-id', updateData);
await api.books.delete('book-id');
```

### Categories

```typescript
// Get all categories
const categories = await api.categories.getAll();

// Get category tree structure
const tree = await api.categories.getTree();

// Get child categories
const children = await api.categories.getChildren('category-id');

// Get books in category
const books = await api.categories.getBooksBySlug('category-slug', 'en');
```

### User Management

```typescript
// Get current user
const user = await api.users.getMe();

// Update current user
const updatedUser = await api.users.updateMe({
  firstName: 'New Name',
});

// User roles (admin only)
const roles = await api.users.getRoles('user-id');
await api.users.addRole('user-id', 'content_manager');
await api.users.removeRole('user-id', 'admin');
```

### Bookshelf (Personal Library)

```typescript
// Get user's bookshelf
const bookshelf = await api.bookshelf.get();

// Add book to bookshelf
await api.bookshelf.add('book-version-id');

// Remove from bookshelf
await api.bookshelf.remove('book-version-id');
```

### Reading Progress

```typescript
// Get reading progress for a book
const progress = await api.readingProgress.get('book-version-id');

// Update reading progress
await api.readingProgress.update('book-version-id', {
  currentPage: 42,
  totalPages: 200,
  progressPercentage: 21,
  lastReadAt: new Date().toISOString(),
});
```

## Error Handling

```typescript
try {
  const books = await api.books.getAll();
} catch (error) {
  if (error.response?.status === 401) {
    // Handle authentication error
    console.log('Please log in');
  } else if (error.response?.status === 403) {
    // Handle permission error
    console.log('Access denied');
  } else if (error.response?.status >= 500) {
    // Handle server error
    console.log('Server error, please try again later');
  } else {
    // Handle other errors
    console.log('Something went wrong:', error.message);
  }
}
```

## TypeScript Support

The client is fully typed with generated OpenAPI types:

```typescript
import type { components } from './api-client/types';

type Book = components['schemas']['Book'];
type User = components['schemas']['User'];
type CreateBookRequest = components['schemas']['CreateBookDto'];
```

## React Integration Example

```typescript
// hooks/useApi.ts
import { useCallback, useEffect, useState } from 'react';
import { BooksApiClient } from '../api-client';

const api = new BooksApiClient({
  baseURL: process.env.REACT_APP_API_URL || 'http://localhost:5000',
});

export const useAuth = () => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(false);

  const login = useCallback(async (email: string, password: string) => {
    setLoading(true);
    try {
      await api.login({ email, password });
      const userData = await api.users.getMe();
      setUser(userData);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  return { user, login, logout, loading };
};

export const useBooks = () => {
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(false);

  const fetchBooks = useCallback(async (params = {}) => {
    setLoading(true);
    try {
      const data = await api.books.getAll(params);
      setBooks(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBooks();
  }, [fetchBooks]);

  return { books, fetchBooks, loading };
};
```

## Next.js Integration Example

```typescript
// lib/api.ts
import { BooksApiClient } from './api-client';

export const api = new BooksApiClient({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000',
});

// pages/api/books.ts
export default async function handler(req, res) {
  try {
    const books = await api.books.getAll();
    res.status(200).json(books);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch books' });
  }
}

// pages/books/[slug].tsx
export async function getStaticProps({ params }) {
  try {
    const book = await api.books.getOverview(params.slug);
    return { props: { book } };
  } catch (error) {
    return { notFound: true };
  }
}
```

## Environment Variables

```bash
# .env.local (for Next.js) or .env (for React)
NEXT_PUBLIC_API_URL=https://your-api-domain.com
# or
REACT_APP_API_URL=https://your-api-domain.com
```

## Development

To regenerate types after API changes:

```bash
# In the backend project
yarn openapi:generate

# Or manually
curl http://localhost:5000/api/docs-json > api-spec.json
openapi-typescript api-spec.json -o libs/api-client/src/types.ts
```

## Support

- **API Documentation**: Visit `/api/docs` on your backend server for Swagger UI
- **Types**: All TypeScript types are auto-generated from OpenAPI spec
- **Issues**: Report issues in the backend repository
