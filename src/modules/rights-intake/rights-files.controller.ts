import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { promises as fs } from 'node:fs';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { RightsFilesService } from './rights-files.service';
import { SupersedeRightsEvidenceDto } from './dto/supersede-rights-evidence.dto';
import type { RightsFileDescriptorDto, RightsFileDownload } from './rights-files.service';

type UploadedFileType = {
  buffer?: Buffer;
  mimetype?: string;
  size?: number;
  path?: string;
  originalname?: string;
};

const uploadInterceptor = () =>
  FileInterceptor(
    'file',
    ((): MulterOptions => ({
      storage: memoryStorage(),
      // Небольшой запас над прикладным лимитом: точную проверку и понятную 413 даёт
      // RightsFileStorageService, multer здесь — только защита от очевидно огромного тела.
      limits: {
        fileSize: (Number(process.env.RIGHTS_FILES_MAX_MB || 25) + 2) * 1024 * 1024,
      },
    }))(),
  );

const MULTIPART_BODY = {
  schema: {
    type: 'object',
    properties: { file: { type: 'string', format: 'binary' } },
    required: ['file'],
  },
};

/**
 * WP-9: юридические файлы системы прав — PDF-отчёт (9.2), файл исходного издания (8.3)
 * и архивная копия доказательства (9.3).
 *
 * Публичного URL у этих файлов нет: скачать их можно только здесь, под ролями
 * Admin/ContentManager. Это отличает их от медиа произведения, для которых риск утёкшей
 * ссылки принят владельцем (ADR-012, пункт 11) — на юридические документы то решение
 * не распространяется.
 */
@ApiTags('Rights Files')
@Controller('admin/rights')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin, Role.ContentManager)
@ApiBearerAuth()
export class RightsFilesController {
  constructor(private readonly service: RightsFilesService) {}

  @Get('files/limits')
  @ApiOperation({ summary: 'Limits and allowed content types for rights file uploads' })
  getLimits() {
    return this.service.getLimits();
  }

  // ---------------------------------------------------------------- report PDF (WP-9.2)

  @Post('review-imports/:importId/report-pdf')
  @ApiOperation({
    summary: 'Upload the PDF version of the rights report',
    description:
      'WP-9.2 (R4-02): требование roadmap фазы 3, не реализованное ни одной из 20 фаз. ' +
      'Контрольную сумму считает сервер. Замена уже загруженного файла запрещена — ' +
      'исправленный отчёт загружается новым импортом.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody(MULTIPART_BODY)
  @ApiParam({ name: 'importId' })
  @UseInterceptors(uploadInterceptor())
  async uploadReportPdf(
    @Param('importId') importId: string,
    @UploadedFile() file: UploadedFileType,
    @Req() req: { user?: { userId?: string } },
  ): Promise<RightsFileDescriptorDto> {
    return this.service.uploadReportPdf(importId, await toUpload(file), req.user?.userId ?? null);
  }

  @Get('review-imports/:importId/report-pdf')
  @ApiOperation({ summary: 'Download the PDF version of the rights report' })
  @ApiParam({ name: 'importId' })
  async downloadReportPdf(@Param('importId') importId: string, @Res() res: Response) {
    send(res, await this.service.downloadReportPdf(importId));
  }

  // ---------------------------------------------------- файл исходного издания (WP-8.3)

  @Post('profiles/:profileId/source-file')
  @ApiOperation({
    summary: 'Upload the source edition file',
    description:
      'WP-8.3 (R3-05): контрольная сумма файла входит в content hash клиренса, поэтому ' +
      'загрузка пересчитывает свежесть всех версий профиля. Замена запрещена.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody(MULTIPART_BODY)
  @ApiParam({ name: 'profileId' })
  @UseInterceptors(uploadInterceptor())
  async uploadSourceFile(
    @Param('profileId') profileId: string,
    @UploadedFile() file: UploadedFileType,
    @Req() req: { user?: { userId?: string } },
  ): Promise<RightsFileDescriptorDto> {
    return this.service.uploadSourceFile(profileId, await toUpload(file), req.user?.userId ?? null);
  }

  @Get('profiles/:profileId/source-file')
  @ApiOperation({ summary: 'Download the source edition file' })
  @ApiParam({ name: 'profileId' })
  async downloadSourceFile(@Param('profileId') profileId: string, @Res() res: Response) {
    send(res, await this.service.downloadSourceFile(profileId));
  }

  // ------------------------------------------- архивная копия доказательства (WP-9.3)

  @Post('evidence/:evidenceId/archive-copy')
  @ApiOperation({
    summary: 'Upload an archived copy of the evidence document',
    description:
      'WP-9.3 (R3-08): доказательство хранилось одним URL, который завтра отдаст 404 вместе ' +
      'с обоснованием блокировки страны. Копию загружает редактор — сервер по внешним ' +
      'адресам не ходит.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody(MULTIPART_BODY)
  @ApiParam({ name: 'evidenceId' })
  @UseInterceptors(uploadInterceptor())
  async uploadEvidenceArchiveCopy(
    @Param('evidenceId') evidenceId: string,
    @UploadedFile() file: UploadedFileType,
    @Req() req: { user?: { userId?: string } },
  ): Promise<RightsFileDescriptorDto> {
    return this.service.uploadEvidenceArchiveCopy(
      evidenceId,
      await toUpload(file),
      req.user?.userId ?? null,
    );
  }

  @Get('evidence/:evidenceId/archive-copy')
  @ApiOperation({ summary: 'Download the archived copy of the evidence document' })
  @ApiParam({ name: 'evidenceId' })
  async downloadEvidenceArchiveCopy(@Param('evidenceId') evidenceId: string, @Res() res: Response) {
    send(res, await this.service.downloadEvidenceArchiveCopy(evidenceId));
  }

  @Patch('evidence/:evidenceId/supersede')
  @ApiOperation({
    summary: 'Mark the evidence as superseded by another one',
    description:
      'WP-9.3: удалить доказательство нельзя (ADR-009), поэтому «оно больше не действует» ' +
      'выражается ссылкой на преемника.',
  })
  @ApiParam({ name: 'evidenceId' })
  async supersedeEvidence(
    @Param('evidenceId') evidenceId: string,
    @Body() dto: SupersedeRightsEvidenceDto,
  ) {
    return this.service.supersedeEvidence(evidenceId, dto.supersededById);
  }
}

/** Приводит загруженный multipart-файл к буферу вне зависимости от того, где его держал multer. */
async function toUpload(file: UploadedFileType) {
  if (!file) throw new BadRequestException({ message: 'Файл не передан.', code: 'FILE_REQUIRED' });

  let buffer: Buffer;
  if (file.buffer && Buffer.isBuffer(file.buffer)) {
    buffer = file.buffer;
  } else if (file.path) {
    buffer = await fs.readFile(file.path);
    await fs.unlink(file.path).catch(() => undefined);
  } else {
    throw new BadRequestException({
      message: 'Не удалось прочитать загруженный файл.',
      code: 'FILE_UNREADABLE',
    });
  }

  return {
    buffer,
    contentType: file.mimetype || 'application/octet-stream',
    fileName: file.originalname ?? null,
  };
}

function send(res: Response, download: RightsFileDownload): void {
  res.setHeader('Content-Type', download.contentType);
  res.setHeader('Content-Length', String(download.buffer.length));
  // Юридический документ не встраивается в страницу и не кешируется прокси: он приватный.
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${download.fileName.replace(/"/g, '')}"`,
  );
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(download.buffer);
}
