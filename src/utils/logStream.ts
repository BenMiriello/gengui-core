/**
 * Rotating log stream for development.
 * DISABLED: rotating-file-stream is ESM-only and causes import issues in CommonJS context.
 * TODO: Re-enable when migrating to ESM or find CommonJS-compatible alternative.
 */

// import path from 'node:path';
// import { mkdirSync } from 'node:fs';
// import { createStream } from 'rotating-file-stream';

// export function createRotatingLogStream() {
//   const logsDir = path.join(process.cwd(), 'logs');
//   mkdirSync(logsDir, { recursive: true });

//   return createStream(
//     (time) => {
//       if (!time) {
//         const date = new Date().toISOString().split('T')[0];
//         return `app-${date}.jsonl`;
//       }
//       const date = (time as Date).toISOString().split('T')[0];
//       return `app-${date}.jsonl`;
//     },
//     {
//       interval: '1d',
//       path: logsDir,
//       maxFiles: 30,
//       compress: 'gzip',
//     }
//   );
// }

export {}; // Make this a module
