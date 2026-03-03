import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { getLogConfig } from '../config/logging';

const logConfig = getLogConfig();

const loggerInstance = pino({
  ...logConfig,
  serializers: {
    error: pino.stdSerializers.err,
  },
  redact: {
    paths: ['password', 'token', 'authorization', 'accessKey', 'secretKey'],
    remove: true,
  },
});

export const logger = loggerInstance;

export function generateRequestId(): string {
  return randomUUID();
}
