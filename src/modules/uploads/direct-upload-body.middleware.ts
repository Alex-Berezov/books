import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { UploadsService } from './uploads.service';

/**
 * Разбор тела `POST /api/uploads/direct` только по живому upload-токену (`LEGACY-459`).
 *
 * Прежде `express.raw` на 210 МБ стоял в `configureSecurity` и срабатывал раньше `JwtAuthGuard`:
 * любой аноним заставлял процесс буферизовать тело, а 401 получал уже потом. Теперь до чтения тела
 * проверяется `X-Upload-Token`: без него или с истёкшим — 401, тело не читается. С живым — потолок
 * тела берёт сервис (`UploadsService.directUploadBodyLimit`, та же граница, что в `directUpload`).
 *
 * JWT здесь не проверяется: токен — случайный UUID, выданный presign одному пользователю,
 * подобрать его нельзя; совпадение владельца с `Bearer` проверяют гвард и сервис, как прежде.
 * Middleware — модульный (`UploadsModule.configure`), а не `app.use`: так он видит сервис через DI
 * и стоит только на `POST` этого маршрута.
 */
@Injectable()
export class DirectUploadBodyMiddleware implements NestMiddleware {
  constructor(private readonly uploads: UploadsService) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const header = req.headers['x-upload-token'];
    const token = typeof header === 'string' ? header.trim() : '';
    const limit = token ? await this.uploads.directUploadBodyLimit(token) : undefined;
    if (limit === undefined) {
      // Непрочитанное тело Node сбрасывает без буфера; соединение закрываем, чтобы не тянуть его дальше.
      res.setHeader('Connection', 'close');
      throw new UnauthorizedException('Invalid or expired upload token');
    }
    express.raw({ type: '*/*', limit })(req, res, next);
  }
}
