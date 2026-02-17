import { mock } from 'bun:test';
import type { Server } from 'node:http';

import { getEmailServiceMock } from './mocks';

const emailMock = getEmailServiceMock();

const redisStore = new Map<string, string>();

export function clearRedisStore() {
  redisStore.clear();
}

const mockStorageData = new Map<string, Buffer>();
let storageKeyCounter = 0;

export function clearStorageData() {
  mockStorageData.clear();
  storageKeyCounter = 0;
}

mock.module('../../services/storage', () => ({
  storageProvider: {
    upload: async (userId: string, mediaId: string, buffer: Buffer, _mimeType: string) => {
      const key = `${userId}/${mediaId}/${++storageKeyCounter}`;
      mockStorageData.set(key, buffer);
      return key;
    },
    delete: async (key: string) => {
      mockStorageData.delete(key);
    },
    getSignedUrl: async (key: string, _expiresIn?: number) => {
      return `https://test-bucket.s3.amazonaws.com/${key}?signature=test`;
    },
    downloadToBuffer: async (key: string) => {
      const data = mockStorageData.get(key);
      if (!data) throw new Error(`Key not found: ${key}`);
      return data;
    },
    healthCheck: async () => true,
  },
  createStorageProvider: () => ({
    upload: async (userId: string, mediaId: string, buffer: Buffer, _mimeType: string) => {
      const key = `${userId}/${mediaId}/${++storageKeyCounter}`;
      mockStorageData.set(key, buffer);
      return key;
    },
    delete: async (key: string) => {
      mockStorageData.delete(key);
    },
    getSignedUrl: async (key: string, _expiresIn?: number) => {
      return `https://test-bucket.s3.amazonaws.com/${key}?signature=test`;
    },
    downloadToBuffer: async (key: string) => {
      const data = mockStorageData.get(key);
      if (!data) throw new Error(`Key not found: ${key}`);
      return data;
    },
    healthCheck: async () => true,
  }),
}));

mock.module('../../services/imageProcessor', () => ({
  imageProcessor: {
    extractDimensions: async (_buffer: Buffer) => ({ width: 100, height: 100 }),
    createThumbnail: async (buffer: Buffer, _size: number) => buffer,
  },
}));

mock.module('../../services/cache', () => ({
  cache: {
    getMediaUrl: async () => null,
    setMediaUrl: async () => {},
    delMediaUrl: async () => {},
    delMetadata: async () => {},
  },
}));

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
    get: async (key: string) => redisStore.get(key) || null,
    set: async (key: string, value: string) => {
      redisStore.set(key, value);
    },
    del: async (key: string) => {
      redisStore.delete(key);
      return 1;
    },
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

mock.module('../../middleware/generationRateLimiter', () => ({
  generationRateLimiter: noOpRateLimiter,
}));

mock.module('../../middleware/augmentationRateLimiter', () => ({
  augmentationRateLimiter: noOpRateLimiter,
}));

mock.module('../../services/runpod/client', () => ({
  runpodClient: {
    isEnabled: () => false,
    getJobStatus: async () => ({ status: 'COMPLETED' }),
    cancelJob: async () => {},
  },
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
    submitJob: async () => ({ jobId: 'test-job-id' }),
  }),
  getImageProviderName: () => 'test',
}));

const primaryEditors = new Map<string, string>();

export function setPrimaryEditor(documentId: string, sessionId: string) {
  primaryEditors.set(documentId, sessionId);
}

export function clearPrimaryEditors() {
  primaryEditors.clear();
}

mock.module('../../services/presence', () => ({
  presenceService: {
    isPrimaryEditor: async (documentId: string, sessionId: string) => {
      const primary = primaryEditors.get(documentId);
      return primary === sessionId;
    },
    getPrimaryEditor: async (documentId: string) => primaryEditors.get(documentId) || null,
    recordHeartbeat: async () => {},
    renewPrimaryLock: async () => true,
    attemptTakeover: async (documentId: string, sessionId: string) => {
      primaryEditors.set(documentId, sessionId);
      return true;
    },
    getActiveEditorCount: async () => 1,
    removeEditor: async () => {},
    cleanupStaleEditors: async () => {},
  },
}));

mock.module('../../services/sse', () => ({
  sseService: {
    addClient: () => {},
    removeClient: () => {},
    broadcastToDocument: () => {},
    broadcastToUser: () => {},
  },
}));

mock.module('../../services/redis-streams', () => ({
  redisStreams: {
    add: async () => 'mock-stream-id',
  },
}));

const mockStoryNodes = new Map<string, any>();

export function clearMockStoryNodes() {
  mockStoryNodes.clear();
}

export function setMockStoryNode(nodeId: string, node: any) {
  mockStoryNodes.set(nodeId, node);
}

// Always mock graphService for API tests that use setMockStoryNode helper
// Graph integration tests (in __tests__/graph/) create their own connection
{
  mock.module('../../services/graph/graph.service', () => ({
    graphService: {
      __isMocked: true,
      connect: async () => {},
      disconnect: async () => {},
      getConnectionStatus: () => true,
      query: async () => ({ headers: [], data: [], stats: {} }),
      createStoryNode: async () => 'mock-node-id',
      getStoryNodeById: async (nodeId: string, userId: string) => {
        const node = mockStoryNodes.get(nodeId);
        if (!node || node.userId !== userId) return null;
        return node;
      },
      getStoryNodeByIdInternal: async (nodeId: string) => mockStoryNodes.get(nodeId) || null,
      getStoryNodesForDocument: async (documentId: string, userId: string) => {
        const nodes: any[] = [];
        for (const node of mockStoryNodes.values()) {
          if (node.documentId === documentId && node.userId === userId) {
            nodes.push(node);
          }
        }
        return nodes;
      },
      updateStoryNode: async () => {},
      updateStoryNodeStyle: async (
        nodeId: string,
        stylePreset: string | null,
        stylePrompt: string | null
      ) => {
        const node = mockStoryNodes.get(nodeId);
        if (!node) return null;
        node.stylePreset = stylePreset;
        node.stylePrompt = stylePrompt;
        return node;
      },
      updateStoryNodePrimaryMedia: async () => {},
      softDeleteStoryNode: async () => {},
      deleteAllStoryNodesForDocument: async () => {},
      getStoryConnectionsForDocument: async () => [],
      createStoryConnection: async () => 'mock-connection-id',
      softDeleteStoryConnection: async () => {},
      setNodeEmbedding: async () => {},
      findSimilarNodes: async () => [],
      getNodeSimilaritiesForDocument: async () => [],
      getNodeEmbeddingsProjection: async () => [],
    },
  }));

  mock.module('../../services/graph/graph.threads.js', () => ({
    graphThreads: {
      getThreadsForDocument: async () => [],
      getThreadById: async () => null,
      getThreadsForEvent: async () => [],
      getEventsForThread: async () => [],
      renameThread: async () => {},
      deleteThread: async () => {},
    },
  }));
} // end skipGraphMock conditional

mock.module('../../config/env', () => ({
  env: {
    NODE_ENV: 'development',
    PORT: 3000,
    LOG_LEVEL: 'error',
    DB_HOST: 'localhost',
    DB_PORT: 5432,
    DB_USER: 'gengui',
    DB_PASSWORD: 'gengui_dev_pass',
    DB_NAME: 'gengui_test',
    MINIO_ENDPOINT: 'localhost',
    MINIO_PORT: 9000,
    MINIO_ACCESS_KEY: 'minioadmin',
    MINIO_SECRET_KEY: 'minioadmin',
    MINIO_BUCKET: 'media',
    TEXT_INFERENCE_PROVIDER: 'gemini',
    IMAGE_INFERENCE_PROVIDER: 'local',
    EMBEDDING_PROVIDER: 'openai',
    GEMINI_API_KEY: 'test-key',
    OPENAI_API_KEY: 'test-key',
  },
}));

import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { requireAuth, requireEmailVerified } from '../../middleware/auth';
import { errorHandler } from '../../middleware/errorHandler';
import { requireAdmin } from '../../middleware/requireAdmin';
import adminRoutes from '../../routes/admin';
import authRoutes from '../../routes/auth';
import documentRoutes from '../../routes/documents';
import generationRoutes from '../../routes/generations';
import mediaRoutes from '../../routes/media';
import nodeRoutes from '../../routes/nodes';
import tagRoutes from '../../routes/tags';

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

  app.get('/test/require-email-verified', requireAuth, requireEmailVerified(), (_req, res) => {
    res.json({ success: true });
  });

  app.get(
    '/test/require-email-verified-custom',
    requireAuth,
    requireEmailVerified('Custom verification message'),
    (_req, res) => {
      res.json({ success: true });
    }
  );

  app.get('/test/require-admin', requireAdmin, (_req, res) => {
    res.json({ success: true, user: _req.user });
  });

  app.use('/api', authRoutes);
  app.use('/api', adminRoutes);
  app.use('/api', documentRoutes);
  app.use('/api/generations', generationRoutes);
  app.use('/api/media', mediaRoutes);
  app.use('/api', nodeRoutes);
  app.use('/api', tagRoutes);

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

export { emailMock, mockStorageData, mockStoryNodes };
