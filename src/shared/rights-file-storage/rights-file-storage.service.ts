import {
  Inject,
  Injectable,
  Logger,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { StorageService } from '../storage/storage.interface';
import { RIGHTS_FILE_STORAGE_DRIVER } from './rights-file-storage.module-tokens';
import type {
  RightsFileKind,
  RightsFileUpload,
  StoredRightsFile,
} from './rights-file-storage.types';

/** Разрешённые MIME-типы по виду файла. Переопределяются переменными окружения. */
const ALLOWED_CONTENT_TYPES: Record<RightsFileKind, () => string[]> = {
  'report-pdf': () => splitEnv(process.env.RIGHTS_FILES_ALLOWED_REPORT_CT, 'application/pdf'),
  'source-file': () =>
    splitEnv(
      process.env.RIGHTS_FILES_ALLOWED_SOURCE_CT,
      'application/pdf,application/epub+zip,text/plain,text/html,application/xhtml+xml',
    ),
  evidence: () =>
    splitEnv(
      process.env.RIGHTS_FILES_ALLOWED_EVIDENCE_CT,
      'application/pdf,image/png,image/jpeg,image/webp,text/html,text/plain',
    ),
  // Служебные артефакты пишет сервер, а не человек: списка загрузки у них нет.
  'report-json': () => [],
  'report-markdown': () => [],
  'raw-agent-output': () => [],
  'input-manifest': () => [],
};

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/epub+zip': 'epub',
  'application/json': 'json',
  'application/xhtml+xml': 'xhtml',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/markdown': 'md',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

function splitEnv(value: string | undefined, fallback: string): string[] {
  return (value || fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * WP-9: единственная точка записи и чтения юридических файлов системы прав.
 *
 * Публичный URL не вычисляется и никуда не отдаётся сознательно: объект скачивается только
 * бэкендом под ролями Admin/ContentManager. В базе живут ключ и sha256, сам файл — в хранилище.
 */
@Injectable()
export class RightsFileStorageService {
  private readonly logger = new Logger(RightsFileStorageService.name);
  private readonly maxBytes = Number(process.env.RIGHTS_FILES_MAX_MB || 25) * 1024 * 1024;

  constructor(@Inject(RIGHTS_FILE_STORAGE_DRIVER) private readonly storage: StorageService) {}

  /** Лимиты для UI и документации. */
  getLimits() {
    return {
      maxSizeMb: this.maxBytes / (1024 * 1024),
      allowedContentTypes: {
        reportPdf: ALLOWED_CONTENT_TYPES['report-pdf'](),
        sourceFile: ALLOWED_CONTENT_TYPES['source-file'](),
        evidence: ALLOWED_CONTENT_TYPES.evidence(),
      },
    };
  }

  /**
   * Сохраняет загруженный человеком файл. Контрольную сумму считает **сервер**: правило
   * WP-8.2 — источник суммы, по которой сверяется юридический артефакт, не может быть на
   * стороне клиента.
   */
  async saveUpload(kind: RightsFileKind, upload: RightsFileUpload): Promise<StoredRightsFile> {
    const contentType = (upload.contentType || '').split(';')[0].trim().toLowerCase();
    const allowed = ALLOWED_CONTENT_TYPES[kind]();

    if (!allowed.includes(contentType)) {
      throw new UnsupportedMediaTypeException(
        `Unsupported content type '${contentType || 'unknown'}'. Allowed: ${allowed.join(', ')}`,
      );
    }
    if (upload.buffer.length > this.maxBytes) {
      throw new PayloadTooLargeException(`File too large. Max ${this.maxBytes / (1024 * 1024)}MB`);
    }

    return this.write(kind, upload.buffer, contentType, upload.fileName ?? null);
  }

  /**
   * Сохраняет служебный текстовый артефакт (JSON-отчёт, markdown, сырой вывод, манифест).
   * Вызывается сервером, поэтому ни MIME, ни размер не валидируются: их источник — мы сами.
   */
  async saveText(
    kind: RightsFileKind,
    text: string,
    contentType: string,
    fileName?: string | null,
  ): Promise<StoredRightsFile> {
    return this.write(kind, Buffer.from(text, 'utf-8'), contentType, fileName ?? null);
  }

  /**
   * Best-effort вариант `saveText` для горячих путей: недоступность хранилища не должна
   * отменять импорт отчёта — колонка просто останется `null`, а причина уйдёт в лог.
   */
  async trySaveText(
    kind: RightsFileKind,
    text: string,
    contentType: string,
    fileName?: string | null,
  ): Promise<StoredRightsFile | null> {
    try {
      return await this.saveText(kind, text, contentType, fileName);
    } catch (e) {
      this.logger.warn(
        `Failed to archive rights artefact '${kind}': ${(e as Error).message}. ` +
          'The record is stored without a storage key.',
      );
      return null;
    }
  }

  /** Читает объект обратно. `null`, если ключа нет — например, файл потерян на стороне хранилища. */
  async read(storageKey: string): Promise<Buffer | null> {
    if (!this.storage.read) {
      throw new Error('Configured rights file storage driver does not support reading');
    }
    return this.storage.read(storageKey);
  }

  private async write(
    kind: RightsFileKind,
    buffer: Buffer,
    contentType: string,
    fileName: string | null,
  ): Promise<StoredRightsFile> {
    const storageKey = this.generateKey(kind, contentType, fileName);
    await this.storage.save(storageKey, buffer, { contentType });

    return {
      storageKey,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      sizeBytes: buffer.length,
      contentType,
      fileName,
    };
  }

  private generateKey(kind: RightsFileKind, contentType: string, fileName: string | null): string {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, '0');
    const d = String(now.getUTCDate()).padStart(2, '0');
    return `${kind}/${y}/${m}/${d}/${randomUUID()}.${this.resolveExtension(contentType, fileName)}`;
  }

  private resolveExtension(contentType: string, fileName: string | null): string {
    const byContentType = EXTENSION_BY_CONTENT_TYPE[contentType];
    if (byContentType) return byContentType;

    const match = /\.([A-Za-z0-9]{1,8})$/.exec(fileName ?? '');
    return match ? match[1].toLowerCase() : 'bin';
  }
}
