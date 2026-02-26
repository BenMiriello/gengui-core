import pino from 'pino';
import { randomUUID } from 'node:crypto';
import { getMainLogConfig, getAILogConfig } from '../config/logging';

export const logger = pino({
  ...getMainLogConfig(),
  serializers: {
    error: pino.stdSerializers.err,
  },
  redact: {
    paths: ['password', 'token', 'authorization', 'accessKey', 'secretKey'],
    remove: true,
  },
});

export const aiLogger = pino(getAILogConfig());

export function generateAICallId(): string {
  return `ai_${randomUUID()}`;
}

export function generateRequestId(): string {
  return randomUUID();
}
