'use strict';
var __createBinding =
  (this && this.__createBinding) ||
  (Object.create
    ? function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (!desc || ('get' in desc ? !m.__esModule : desc.writable || desc.configurable)) {
          desc = {
            enumerable: true,
            get: function () {
              return m[k];
            },
          };
        }
        Object.defineProperty(o, k2, desc);
      }
    : function (o, m, k, k2) {
        if (k2 === undefined) k2 = k;
        o[k2] = m[k];
      });
var __exportStar =
  (this && this.__exportStar) ||
  function (m, exports) {
    for (var p in m)
      if (p !== 'default' && !Object.prototype.hasOwnProperty.call(exports, p))
        __createBinding(exports, m, p);
  };
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, '__esModule', { value: true });
exports.BooksApiClient = void 0;
const axios_1 = __importDefault(require('axios'));
// API client class
class BooksApiClient {
  constructor(config = {}) {
    // Books API
    this.books = {
      getAll: async (params) => {
        const response = await this.get('/api/books', { params });
        return response.data;
      },
      getById: async (id) => {
        const response = await this.get(`/api/books/${id}`);
        return response.data;
      },
      getBySlug: async (slug) => {
        const response = await this.get(`/api/books/slug/${slug}`);
        return response.data;
      },
      getOverview: async (slug, lang) => {
        const url = lang ? `/api/${lang}/books/${slug}/overview` : `/api/books/${slug}/overview`;
        const response = await this.get(url);
        return response.data;
      },
      create: async (data) => {
        const response = await this.post('/api/books', data);
        return response.data;
      },
      update: async (id, data) => {
        const response = await this.patch(`/api/books/${id}`, data);
        return response.data;
      },
      delete: async (id) => {
        await this.delete(`/api/books/${id}`);
      },
    };
    // Categories API
    this.categories = {
      getAll: async () => {
        const response = await this.get('/api/categories');
        return response.data;
      },
      getTree: async () => {
        const response = await this.get('/api/categories/tree');
        return response.data;
      },
      getChildren: async (id) => {
        const response = await this.get(`/api/categories/${id}/children`);
        return response.data;
      },
      getAncestors: async (id) => {
        const response = await this.get(`/api/categories/${id}/ancestors`);
        return response.data;
      },
      getBooksBySlug: async (slug, lang) => {
        const url = lang
          ? `/api/${lang}/categories/${slug}/books`
          : `/api/categories/${slug}/books`;
        const response = await this.get(url);
        return response.data;
      },
      create: async (data) => {
        const response = await this.post('/api/categories', data);
        return response.data;
      },
      update: async (id, data) => {
        const response = await this.patch(`/api/categories/${id}`, data);
        return response.data;
      },
      delete: async (id) => {
        await this.delete(`/api/categories/${id}`);
      },
    };
    // Users API
    this.users = {
      getMe: async () => {
        const response = await this.get('/api/users/me');
        return response.data;
      },
      updateMe: async (data) => {
        const response = await this.patch('/api/users/me', data);
        return response.data;
      },
      getAll: async (params) => {
        const response = await this.get('/api/users', { params });
        return response.data;
      },
      getById: async (id) => {
        const response = await this.get(`/api/users/${id}`);
        return response.data;
      },
      delete: async (id) => {
        await this.delete(`/api/users/${id}`);
      },
      // User roles
      getRoles: async (id) => {
        const response = await this.get(`/api/users/${id}/roles`);
        return response.data;
      },
      addRole: async (id, role) => {
        const response = await this.post(`/api/users/${id}/roles/${role}`);
        return response.data;
      },
      removeRole: async (id, role) => {
        await this.delete(`/api/users/${id}/roles/${role}`);
      },
    };
    // Bookshelf API
    this.bookshelf = {
      get: async () => {
        const response = await this.get('/api/me/bookshelf');
        return response.data;
      },
      add: async (versionId) => {
        const response = await this.post(`/api/me/bookshelf/${versionId}`);
        return response.data;
      },
      remove: async (versionId) => {
        await this.delete(`/api/me/bookshelf/${versionId}`);
      },
    };
    // Reading Progress API
    this.readingProgress = {
      get: async (versionId) => {
        const response = await this.get(`/api/me/progress/${versionId}`);
        return response.data;
      },
      update: async (versionId, data) => {
        const response = await this.put(`/api/me/progress/${versionId}`, data);
        return response.data;
      },
    };
    // Health API
    this.health = {
      liveness: async () => {
        const response = await this.get('/api/health/liveness');
        return response.data;
      },
      readiness: async () => {
        const response = await this.get('/api/health/readiness');
        return response.data;
      },
    };
    const {
      baseURL = 'http://localhost:5000',
      timeout = 30000,
      headers = {},
      accessToken,
    } = config;
    this.axios = axios_1.default.create({
      baseURL,
      timeout,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    });
    if (accessToken) {
      this.setAccessToken(accessToken);
    }
    this.setupInterceptors();
  }
  setupInterceptors() {
    // Request interceptor for auth
    this.axios.interceptors.request.use(
      (config) => {
        if (this.accessToken && config.headers) {
          config.headers['Authorization'] = `Bearer ${this.accessToken}`;
        }
        return config;
      },
      (error) => Promise.reject(error instanceof Error ? error : new Error(String(error))),
    );
    this.axios.interceptors.response.use(
      (response) => response,
      async (error) => {
        if (error.response?.status === 401 && this.refreshToken) {
          try {
            const tokens = await this.refreshAccessToken();
            this.setTokens(tokens);
            // Retry original request
            const originalRequest = error.config;
            originalRequest.headers['Authorization'] = `Bearer ${tokens.accessToken}`;
            return this.axios.request(originalRequest);
          } catch (refreshError) {
            this.clearTokens();
            throw refreshError;
          }
        }
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  }
  // Authentication methods
  setAccessToken(token) {
    this.accessToken = token;
    this.axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  }
  setTokens(tokens) {
    this.accessToken = tokens.accessToken;
    this.refreshToken = tokens.refreshToken;
    this.setAccessToken(tokens.accessToken);
  }
  clearTokens() {
    this.accessToken = undefined;
    this.refreshToken = undefined;
    delete this.axios.defaults.headers.common['Authorization'];
  }
  // Auth endpoints
  async login(credentials) {
    const response = await this.axios.post('/api/auth/login', credentials);
    const tokens = response.data;
    this.setTokens(tokens);
    return tokens;
  }
  async register(data) {
    const response = await this.axios.post('/api/auth/register', data);
    const tokens = response.data;
    this.setTokens(tokens);
    return tokens;
  }
  async logout() {
    if (this.refreshToken) {
      await this.axios.post('/api/auth/logout', { refreshToken: this.refreshToken });
    }
    this.clearTokens();
  }
  async refreshAccessToken() {
    if (!this.refreshToken) {
      throw new Error('No refresh token available');
    }
    const response = await this.axios.post('/api/auth/refresh', {
      refreshToken: this.refreshToken,
    });
    return response.data;
  }
  // Generic request methods with typed responses
  async get(url, config) {
    return this.axios.get(url, config);
  }
  async post(url, data, config) {
    return this.axios.post(url, data, config);
  }
  async put(url, data, config) {
    return this.axios.put(url, data, config);
  }
  async patch(url, data, config) {
    return this.axios.patch(url, data, config);
  }
  async delete(url, config) {
    return this.axios.delete(url, config);
  }
}
exports.BooksApiClient = BooksApiClient;
// Default export
exports.default = BooksApiClient;
// Re-export types
__exportStar(require('./types'), exports);
