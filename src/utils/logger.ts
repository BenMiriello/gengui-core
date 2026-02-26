import pino from 'pino';
import { randomUUID } from 'node:crypto';
import { getLogConfig } from '../config/logging';
import { createRotatingLogStream } from './logStream';

const isDevelopment = process.env.NODE_ENV === 'development';

// In development, use multistream for both console and rotating file
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
      pino.multistream([
        {
          level: process.env.LOG_LEVEL || 'debug',
          stream: pino.transport({
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss',
              ignore: 'pid,hostname',
            },
          }),
        },
        {
          level: process.env.LOG_LEVEL || 'debug',
          stream: createRotatingLogStream(),
        },
      ])
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
