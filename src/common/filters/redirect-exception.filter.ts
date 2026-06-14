import { ExceptionFilter, Catch, ArgumentsHost } from '@nestjs/common';
import { Response } from 'express';
import { RedirectException } from '../exceptions/redirect.exception';

@Catch(RedirectException)
export class RedirectExceptionFilter implements ExceptionFilter {
  catch(exception: RedirectException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    response.redirect(301, exception.url);
  }
}
