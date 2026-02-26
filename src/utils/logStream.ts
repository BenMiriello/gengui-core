/**
 * Rotating log stream for development.
 * Creates daily log files: app-2026-02-25.jsonl
 */

import { createStream } from 'rotating-file-stream';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

export function createRotatingLogStream() {
  const logsDir = path.join(process.cwd(), 'logs');
  mkdirSync(logsDir, { recursive: true });

  return createStream(
    (time) => {
      if (!time) {
        // Current log file
        const date = new Date().toISOString().split('T')[0];
        return `app-${date}.jsonl`;
      }
      // Rotated log file (add timestamp to differentiate)
      const date = time.toISOString().split('T')[0];
      return `app-${date}.jsonl`;
    },
    {
      interval: '1d', // Rotate daily
      path: logsDir,
      maxFiles: 30, // Keep 30 days of logs
      compress: 'gzip', // Compress old logs
    }
  );
}
