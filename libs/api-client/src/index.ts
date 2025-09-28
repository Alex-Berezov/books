import axios, {
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios';

// Re-export key types for consumers
export type { components, paths } from './types';

// Base API configuration
export interface ApiClientConfig {
  baseURL?: string;
  timeout?: number;
  headers?: Record<string, string>;
  apiKey?: string;
  accessToken?: string;
}

// Authentication types
export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterData {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

// Response interceptor for token refresh
export interface AxiosErrorWithConfig extends Error {
  config: AxiosRequestConfig;
  response?: {
    status: number;
    [key: string]: any;
  };
}

export interface AxiosResponseInterceptor {
  (response: AxiosResponse): AxiosResponse;
}

export interface AxiosErrorInterceptor {
  (error: AxiosErrorWithConfig): Promise<AxiosResponse>;
}

// API client class
export class BooksApiClient {
  private axios: AxiosInstance;
  private accessToken?: string;
  private refreshToken?: string;

  constructor(config: ApiClientConfig = {}) {
    const {
      baseURL = 'http://localhost:5000',
      timeout = 30000,
      headers = {},
      accessToken,
    } = config;

    this.axios = axios.create({
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

  private setupInterceptors() {
    // Request interceptor for auth
    this.axios.interceptors.request.use(
      (config: InternalAxiosRequestConfig): InternalAxiosRequestConfig => {
        if (this.accessToken && config.headers) {
          config.headers['Authorization'] = `Bearer ${this.accessToken}`;
        }
        return config;
      },
      (error: unknown): Promise<never> =>
        Promise.reject(error instanceof Error ? error : new Error(String(error))),
    );

    this.axios.interceptors.response.use(
      ((response: AxiosResponse): AxiosResponse => response) as AxiosResponseInterceptor,
      (async (error: AxiosErrorWithConfig): Promise<AxiosResponse> => {
        if (error.response?.status === 401 && this.refreshToken) {
          try {
            const tokens = await this.refreshAccessToken();
            this.setTokens(tokens);

            // Retry original request
            const originalRequest = error.config;
            (originalRequest.headers as Record<string, string>)['Authorization'] =
              `Bearer ${tokens.accessToken}`;
            return this.axios.request(originalRequest);
          } catch (refreshError) {
            this.clearTokens();
            throw refreshError;
          }
        }
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }) as AxiosErrorInterceptor,
    );
  }

  // Authentication methods
  setAccessToken(token: string) {
    this.accessToken = token;
    this.axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  }

  setTokens(tokens: AuthTokens) {
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
  async login(credentials: LoginCredentials): Promise<AuthTokens> {
    const response = await this.axios.post<AuthTokens>('/api/auth/login', credentials);
    const tokens = response.data;
    this.setTokens(tokens);
    return tokens;
  }

  async register(data: RegisterData): Promise<AuthTokens> {
    const response = await this.axios.post<AuthTokens>('/api/auth/register', data);
    const tokens = response.data;
    this.setTokens(tokens);
    return tokens;
  }

  async logout(): Promise<void> {
    if (this.refreshToken) {
      await this.axios.post('/api/auth/logout', { refreshToken: this.refreshToken });
    }
    this.clearTokens();
  }

  private async refreshAccessToken(): Promise<AuthTokens> {
    if (!this.refreshToken) {
      throw new Error('No refresh token available');
    }

    const response = await this.axios.post<AuthTokens>('/api/auth/refresh', {
      refreshToken: this.refreshToken,
    });
    return response.data;
  }

  // Generic request methods with typed responses
  async get<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.axios.get<T>(url, config);
  }

  async post<T = any>(
    url: string,
    data?: any,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    return this.axios.post<T>(url, data, config);
  }

  async put<T = any>(
    url: string,
    data?: any,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    return this.axios.put<T>(url, data, config);
  }

  async patch<T = any>(
    url: string,
    data?: any,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    return this.axios.patch<T>(url, data, config);
  }

  async delete<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.axios.delete<T>(url, config);
  }

  // Books API
  books = {
    getAll: async (params?: { limit?: number; offset?: number; language?: string }) => {
      const response = await this.get('/api/books', { params });
      return response.data;
    },

    getById: async (id: string) => {
      const response = await this.get(`/api/books/${id}`);
      return response.data;
    },

    getBySlug: async (slug: string) => {
      const response = await this.get(`/api/books/slug/${slug}`);
      return response.data;
    },

    getOverview: async (slug: string, lang?: string) => {
      const url = lang ? `/api/${lang}/books/${slug}/overview` : `/api/books/${slug}/overview`;
      const response = await this.get(url);
      return response.data;
    },

    create: async (data: any) => {
      const response = await this.post('/api/books', data);
      return response.data;
    },

    update: async (id: string, data: any) => {
      const response = await this.patch(`/api/books/${id}`, data);
      return response.data;
    },

    delete: async (id: string) => {
      await this.delete(`/api/books/${id}`);
    },
  };

  // Categories API
  categories = {
    getAll: async () => {
      const response = await this.get('/api/categories');
      return response.data;
    },

    getTree: async () => {
      const response = await this.get('/api/categories/tree');
      return response.data;
    },

    getChildren: async (id: string) => {
      const response = await this.get(`/api/categories/${id}/children`);
      return response.data;
    },

    getAncestors: async (id: string) => {
      const response = await this.get(`/api/categories/${id}/ancestors`);
      return response.data;
    },

    getBooksBySlug: async (slug: string, lang?: string) => {
      const url = lang ? `/api/${lang}/categories/${slug}/books` : `/api/categories/${slug}/books`;
      const response = await this.get(url);
      return response.data;
    },

    create: async (data: any) => {
      const response = await this.post('/api/categories', data);
      return response.data;
    },

    update: async (id: string, data: any) => {
      const response = await this.patch(`/api/categories/${id}`, data);
      return response.data;
    },

    delete: async (id: string) => {
      await this.delete(`/api/categories/${id}`);
    },
  };

  // Users API
  users = {
    getMe: async () => {
      const response = await this.get('/api/users/me');
      return response.data;
    },

    updateMe: async (data: any) => {
      const response = await this.patch('/api/users/me', data);
      return response.data;
    },

    getAll: async (params?: { limit?: number; offset?: number }) => {
      const response = await this.get('/api/users', { params });
      return response.data;
    },

    getById: async (id: string) => {
      const response = await this.get(`/api/users/${id}`);
      return response.data;
    },

    delete: async (id: string) => {
      await this.delete(`/api/users/${id}`);
    },

    // User roles
    getRoles: async (id: string) => {
      const response = await this.get(`/api/users/${id}/roles`);
      return response.data;
    },

    addRole: async (id: string, role: string) => {
      const response = await this.post(`/api/users/${id}/roles/${role}`);
      return response.data;
    },

    removeRole: async (id: string, role: string) => {
      await this.delete(`/api/users/${id}/roles/${role}`);
    },
  };

  // Bookshelf API
  bookshelf = {
    get: async () => {
      const response = await this.get('/api/me/bookshelf');
      return response.data;
    },

    add: async (versionId: string) => {
      const response = await this.post(`/api/me/bookshelf/${versionId}`);
      return response.data;
    },

    remove: async (versionId: string) => {
      await this.delete(`/api/me/bookshelf/${versionId}`);
    },
  };

  // Reading Progress API
  readingProgress = {
    get: async (versionId: string) => {
      const response = await this.get(`/api/me/progress/${versionId}`);
      return response.data;
    },

    update: async (versionId: string, data: any) => {
      const response = await this.put(`/api/me/progress/${versionId}`, data);
      return response.data;
    },
  };

  // Health API
  health = {
    liveness: async () => {
      const response = await this.get('/api/health/liveness');
      return response.data;
    },

    readiness: async () => {
      const response = await this.get('/api/health/readiness');
      return response.data;
    },
  };
}

// Default export
export default BooksApiClient;

// Re-export types
export * from './types';
