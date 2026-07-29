import { HttpException } from '@nestjs/common';
import {
  LAWYER_ERROR_MESSAGES_EN,
  LAWYER_ERROR_MESSAGES_RU,
  type LawyerErrorCode,
} from './rights-lawyer.constants';

export interface LawyerErrorBody {
  statusCode: number;
  code: LawyerErrorCode;
  message: string;
  messageRu: string;
  details?: Record<string, unknown>;
}

/**
 * Every error raised by the lawyer module uses one body shape:
 * `{ statusCode, code, message, messageRu, details? }`.
 */
export const lawyerError = (
  status: number,
  code: LawyerErrorCode,
  details?: Record<string, unknown>,
): HttpException => {
  const body: LawyerErrorBody = {
    statusCode: status,
    code,
    message: LAWYER_ERROR_MESSAGES_EN[code],
    messageRu: LAWYER_ERROR_MESSAGES_RU[code],
  };
  if (details) {
    body.details = details;
  }
  return new HttpException(body, status);
};
