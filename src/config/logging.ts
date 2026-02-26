/**
 * Environment-based logging configuration.
 * Separates main application logs from verbose AI prompt/response logs.
 */

export function getMainLogConfig() {
  const isProduction = process.env.NODE_ENV === 'production';
  const isDevelopment = process.env.NODE_ENV === 'development';
  const isRemote = process.env.DEPLOY_ENV === 'remote';

  if (isProduction || isRemote) {
    return {
      level: process.env.LOG_LEVEL || 'info',
      // stdout only - captured by K8s/Docker
    };
  }

  if (isDevelopment) {
    return {
      level: process.env.LOG_LEVEL || 'debug',
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      },
    };
  }

  return { level: 'silent' };
}

export function getAILogConfig() {
  const isProduction = process.env.NODE_ENV === 'production';
  const isDevelopment = process.env.NODE_ENV === 'development';
  const isRemote = process.env.DEPLOY_ENV === 'remote';

  if (isProduction || isRemote) {
    return {
      level: 'debug',
      base: { logType: 'ai' }, // For filtering in CloudWatch
    };
  }

  if (isDevelopment) {
    return {
      level: 'debug',
      transport: {
        target: 'pino/file',
        options: {
          destination: './logs/ai/prompts.jsonl',
          mkdir: true,
        },
      },
    };
  }

  return { level: 'silent' };
}
