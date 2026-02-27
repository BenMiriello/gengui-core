/**
 * Environment-based logging configuration.
 *
 * Development:
 *   - Structured JSON to rotating daily files (./logs/app-YYYY-MM-DD.jsonl)
 *   - Pretty console output
 *   - LOG_VERBOSE=true enables full prompts/responses/entity names (LOCAL ONLY)
 *
 * Production:
 *   - Structured JSON to stdout (captured by Fluent Bit → S3/CloudWatch)
 *   - PII-safe: Never logs document content, entity names, full prompts
 *   - LOG_VERBOSE ignored (security hardening)
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';

export function getLogConfig() {
  const isProduction = process.env.NODE_ENV === 'production';
  const isDevelopment = process.env.NODE_ENV === 'development';
  const isRemote = process.env.DEPLOY_ENV === 'remote';
  const logLevel = process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info');

  // Production/Remote: JSON to stdout (captured by infrastructure)
  if (isProduction || isRemote) {
    return {
      level: logLevel,
      // Structured JSON to stdout - captured by Fluent Bit
      // LOG_VERBOSE is IGNORED in production for security
    };
  }

  // Development: JSON to rotating daily files + pretty console
  if (isDevelopment) {
    mkdirSync('./logs', { recursive: true });

    return {
      level: logLevel,
      transport: {
        targets: [
          {
            // Pretty console for real-time monitoring
            target: 'pino-pretty',
            level: logLevel,
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss',
              ignore: 'pid,hostname',
            },
          },
          {
            // Structured JSON to rotating daily files
            target: 'pino/file',
            level: logLevel,
            options: {
              destination: path.join(process.cwd(), 'logs', 'app-%DATE%.jsonl'),
              mkdir: true,
            },
          },
        ],
      },
    };
  }

  // Test mode
  return { level: 'silent' };
}

/**
 * Check if verbose logging is enabled (LOCAL ONLY).
 *
 * When true, logs include:
 * - Full LLM prompts and responses (not truncated)
 * - Entity names and facet content
 * - Document snippets
 *
 * BLOCKED in production for PII safety.
 */
export function isVerboseLoggingEnabled(): boolean {
  const isProduction = process.env.NODE_ENV === 'production';
  const isRemote = process.env.DEPLOY_ENV === 'remote';

  // Never allow verbose logging in production
  if (isProduction || isRemote) {
    return false;
  }

  // In development, respect LOG_VERBOSE env var
  return process.env.LOG_VERBOSE === 'true';
}
