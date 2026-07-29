import { HttpException } from '@nestjs/common';
import {
  RECHECK_ERROR_MESSAGES_EN,
  RECHECK_ERROR_MESSAGES_RU,
  type RecheckErrorCode,
} from './rights-recheck.constants';

export interface RecheckErrorBody {
  statusCode: number;
  code: RecheckErrorCode;
  message: string;
  messageRu: string;
  details?: Record<string, unknown>;
}

/**
 * Every error raised by the recheck module uses one body shape:
 * `{ statusCode, code, message, messageRu, details? }`.
 */
export const recheckError = (
  status: number,
  code: RecheckErrorCode,
  details?: Record<string, unknown>,
): HttpException => {
  const body: RecheckErrorBody = {
    statusCode: status,
    code,
    message: RECHECK_ERROR_MESSAGES_EN[code],
    messageRu: RECHECK_ERROR_MESSAGES_RU[code],
  };
  if (details) {
    body.details = details;
  }
  return new HttpException(body, status);
};
