import { AxiosRequestConfig, AxiosResponse } from 'axios';
export type { components, paths } from './types';
export interface ApiClientConfig {
  baseURL?: string;
  timeout?: number;
  headers?: Record<string, string>;
  apiKey?: string;
  accessToken?: string;
}
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
export declare class BooksApiClient {
  private axios;
  private accessToken?;
  private refreshToken?;
  constructor(config?: ApiClientConfig);
  private setupInterceptors;
  setAccessToken(token: string): void;
  setTokens(tokens: AuthTokens): void;
  clearTokens(): void;
  login(credentials: LoginCredentials): Promise<AuthTokens>;
  register(data: RegisterData): Promise<AuthTokens>;
  logout(): Promise<void>;
  private refreshAccessToken;
  get<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  post<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  put<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  patch<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  delete<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  books: {
    getAll: (params?: { limit?: number; offset?: number; language?: string }) => Promise<any>;
    getById: (id: string) => Promise<any>;
    getBySlug: (slug: string) => Promise<any>;
    getOverview: (slug: string, lang?: string) => Promise<any>;
    create: (data: any) => Promise<any>;
    update: (id: string, data: any) => Promise<any>;
    delete: (id: string) => Promise<void>;
  };
  categories: {
    getAll: () => Promise<any>;
    getTree: () => Promise<any>;
    getChildren: (id: string) => Promise<any>;
    getAncestors: (id: string) => Promise<any>;
    getBooksBySlug: (slug: string, lang?: string) => Promise<any>;
    create: (data: any) => Promise<any>;
    update: (id: string, data: any) => Promise<any>;
    delete: (id: string) => Promise<void>;
  };
  users: {
    getMe: () => Promise<any>;
    updateMe: (data: any) => Promise<any>;
    getAll: (params?: { limit?: number; offset?: number }) => Promise<any>;
    getById: (id: string) => Promise<any>;
    delete: (id: string) => Promise<void>;
    getRoles: (id: string) => Promise<any>;
    addRole: (id: string, role: string) => Promise<any>;
    removeRole: (id: string, role: string) => Promise<void>;
  };
  bookshelf: {
    get: () => Promise<any>;
    add: (versionId: string) => Promise<any>;
    remove: (versionId: string) => Promise<void>;
  };
  readingProgress: {
    get: (versionId: string) => Promise<any>;
    update: (versionId: string, data: any) => Promise<any>;
  };
  health: {
    liveness: () => Promise<any>;
    readiness: () => Promise<any>;
  };
}
export default BooksApiClient;
export * from './types';
