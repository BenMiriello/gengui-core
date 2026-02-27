import pino from 'pino';
import { randomUUID } from 'node:crypto';
import { getLogConfig } from '../config/logging';

const isDevelopment = process.env.NODE_ENV === 'development';

// In development, use pino-pretty for console output
// File logging disabled due to ESM import issues with rotating-file-stream
const loggerInstance = isDevelopment
  ? pino(
      {
        level: process.env.LOG_LEVEL || 'debug',
        serializers: {
          error: pino.stdSerializers.err,
        },
        redact: {
          paths: ['password', 'token', 'authorization', 'accessKey', 'secretKey'],
          remove: true,
        },
      },
      pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      })
    )
  : pino({
      ...getLogConfig(),
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
