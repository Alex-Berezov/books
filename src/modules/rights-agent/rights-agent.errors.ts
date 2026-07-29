import { HttpException } from '@nestjs/common';
import {
  AGENT_ERROR_MESSAGES_EN,
  AGENT_ERROR_MESSAGES_RU,
  type AgentErrorCode,
} from './rights-agent.constants';

export interface AgentErrorBody {
  statusCode: number;
  code: AgentErrorCode;
  message: string;
  messageRu: string;
  details?: Record<string, unknown>;
}

/**
 * Every error raised by the agent module uses one body shape:
 * `{ statusCode, code, message, messageRu, details? }`.
 */
export const agentError = (
  status: number,
  code: AgentErrorCode,
  details?: Record<string, unknown>,
): HttpException => {
  const body: AgentErrorBody = {
    statusCode: status,
    code,
    message: AGENT_ERROR_MESSAGES_EN[code],
    messageRu: AGENT_ERROR_MESSAGES_RU[code],
  };
  if (details) {
    body.details = details;
  }
  return new HttpException(body, status);
};
