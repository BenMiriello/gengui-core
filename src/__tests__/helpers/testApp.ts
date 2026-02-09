import { mock } from 'bun:test';
import type { Server } from 'node:http';

import { getEmailServiceMock } from './mocks';

const emailMock = getEmailServiceMock();

const redisStore = new Map<string, string>();

export function clearRedisStore() {
  redisStore.clear();
}

const mockRedisClient = {
  status: 'ready',
  mode: 'standalone',
  on: (_event: string, _handler: (...args: unknown[]) => void) => {
    return mockRedisClient;
  },
  call: async (...args: unknown[]) => {
    const [command, ...rest] = args as [string, ...string[]];
    if (command === 'GET') return redisStore.get(rest[0]) || null;
    if (command === 'SET') {
      redisStore.set(rest[0], rest[1]);
      return 'OK';
    }
    if (command === 'INCR') {
      const val = (Number.parseInt(redisStore.get(rest[0]) || '0', 10) + 1).toString();
      redisStore.set(rest[0], val);
      return Number.parseInt(val, 10);
    }
    if (command === 'PEXPIRE') return 1;
    if (command === 'PTTL') return 60000;
    return null;
  },
  get: async (key: string) => redisStore.get(key) || null,
  set: async (key: string, value: string) => {
    redisStore.set(key, value);
    return 'OK';
  },
  setex: async (key: string, _ttl: number, value: string) => {
    redisStore.set(key, value);
    return 'OK';
  },
  del: async (key: string) => {
    redisStore.delete(key);
    return 1;
  },
  hset: async () => 1,
  hgetall: async () => ({}),
  lpush: async () => 1,
  brpop: async () => null,
  llen: async () => 0,
  lrange: async () => [],
  zadd: async () => 1,
  zcard: async () => 0,
  zrem: async () => 1,
  zremrangebyscore: async () => 0,
  zrange: async () => [],
  eval: async () => null,
  expire: async () => 1,
  publish: async () => 0,
  psubscribe: async () => {},
  quit: async () => {},
};

mock.module('../../services/redis', () => ({
  redis: {
    getClient: () => mockRedisClient,
    getSubscriber: () => mockRedisClient,
    getConnectionStatus: () => true,
    disconnect: async () => {},
    addJob: async () => {},
    getJob: async () => null,
    updateJob: async () => {},
    subscribe: async () => {},
    publish: async () => 0,
    brpop: async () => null,
    lpush: async () => 1,
    llen: async () => 0,
    lrange: async () => [],
    get: async () => null,
    set: async () => {},
    del: async () => 1,
    zadd: async () => 1,
    zcard: async () => 0,
    zrem: async () => 1,
    zremrangebyscore: async () => 0,
    zrange: async () => [],
    eval: async () => null,
    expire: async () => 1,
  },
}));

const noOpRateLimiter = (_req: unknown, _res: unknown, next: () => void) => next();

mock.module('../../middleware/rateLimiter', () => ({
  authRateLimiter: noOpRateLimiter,
  signupRateLimiter: noOpRateLimiter,
  passwordResetRateLimiter: noOpRateLimiter,
  emailVerificationRateLimiter: noOpRateLimiter,
}));

mock.module('../../services/emailService', () => ({
  emailService: emailMock,
  EmailService: class {
    sendVerificationEmail = emailMock.sendVerificationEmail;
    sendEmailChangeVerification = emailMock.sendEmailChangeVerification;
    sendPasswordResetEmail = emailMock.sendPasswordResetEmail;
    sendPasswordChangedEmail = emailMock.sendPasswordChangedEmail;
  },
}));

mock.module('../../services/image-generation/factory', () => ({
  getImageProvider: async () => ({
    name: 'test',
    validateDimensions: () => true,
    getSupportedDimensions: () => [
      { width: 1024, height: 1024 },
      { width: 512, height: 512 },
    ],
    generateImage: async () => ({
      success: true,
      imageData: Buffer.from('fake-image'),
    }),
  }),
}));

import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { errorHandler } from '../../middleware/errorHandler';
import authRoutes from '../../routes/auth';

function createTestApp() {
  const app = express();

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'http:', 'https:'],
          upgradeInsecureRequests: null,
        },
      },
    })
  );

  app.use(
    cors({
      origin: ['http://localhost:5173', 'http://localhost:3001'],
      credentials: true,
    })
  );

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api', authRoutes);

  app.use(errorHandler);

  return app;
}

let server: Server | null = null;
let serverPort: number = 0;

export async function startTestServer(): Promise<{
  app: ReturnType<typeof createTestApp>;
  port: number;
  baseUrl: string;
}> {
  const app = createTestApp();

  return new Promise((resolve, reject) => {
    server = app.listen(0, () => {
      const address = server?.address();
      if (typeof address === 'object' && address !== null) {
        serverPort = address.port;
        resolve({
          app,
          port: serverPort,
          baseUrl: `http://127.0.0.1:${serverPort}`,
        });
      } else {
        reject(new Error('Failed to get server address'));
      }
    });

    server.on('error', reject);
  });
}

export async function stopTestServer(): Promise<void> {
  if (server) {
    return new Promise((resolve) => {
      server?.close(() => {
        server = null;
        serverPort = 0;
        resolve();
      });
    });
  }
}

export function getServerPort(): number {
  return serverPort;
}

export function getBaseUrl(): string {
  return `http://127.0.0.1:${serverPort}`;
}

export { emailMock };
