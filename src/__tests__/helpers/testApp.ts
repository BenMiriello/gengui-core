import { mock } from 'bun:test';

import { getEmailServiceMock } from './mocks';

const redisStore = new Map<string, string>();
const mockStorageData = new Map<string, Buffer>();
const mockStoryNodes = new Map<string, unknown>();
const primaryEditors = new Map<string, string>();
const storageKeyCounter = { value: 0 };
const testServer: { server: unknown; port: number } = { server: null, port: 0 };

export function clearRedisStore() {
  redisStore.clear();
}

export function clearStorageData() {
  mockStorageData.clear();
  storageKeyCounter.value = 0;
}

mock.module('../../services/storage', () => ({
  storageProvider: {
    upload: async (
      userId: string,
      mediaId: string,
      buffer: Buffer,
      _mimeType: string,
    ) => {
      const key = `${userId}/${mediaId}/${++storageKeyCounter.value}`;
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
    upload: async (
      userId: string,
      mediaId: string,
      buffer: Buffer,
      _mimeType: string,
    ) => {
      const key = `${userId}/${mediaId}/${++storageKeyCounter.value}`;
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
      const val = (
        Number.parseInt(redisStore.get(rest[0]) || '0', 10) + 1
      ).toString();
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

mock.module('../../middleware/rateLimiter', () => {
  const noOpRateLimiter = (_req: unknown, _res: unknown, next: () => void) =>
    next();
  return {
    authRateLimiter: noOpRateLimiter,
    signupRateLimiter: noOpRateLimiter,
    passwordResetRateLimiter: noOpRateLimiter,
    emailVerificationRateLimiter: noOpRateLimiter,
  };
});

mock.module('../../middleware/generationRateLimiter', () => ({
  generationRateLimiter: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

mock.module('../../middleware/augmentationRateLimiter', () => ({
  augmentationRateLimiter: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

mock.module('../../services/runpod/client', () => ({
  runpodClient: {
    isEnabled: () => false,
    getJobStatus: async () => ({ status: 'COMPLETED' }),
    cancelJob: async () => {},
  },
}));

mock.module('../../services/emailService', () => {
  const emailMock = getEmailServiceMock();
  return {
    emailService: emailMock,
    EmailService: class {
      sendVerificationEmail = emailMock.sendVerificationEmail;
      sendEmailChangeVerification = emailMock.sendEmailChangeVerification;
      sendPasswordResetEmail = emailMock.sendPasswordResetEmail;
      sendPasswordChangedEmail = emailMock.sendPasswordChangedEmail;
    },
  };
});

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
    getPrimaryEditor: async (documentId: string) =>
      primaryEditors.get(documentId) || null,
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

export function clearMockStoryNodes() {
  mockStoryNodes.clear();
}

export function setMockStoryNode(nodeId: string, node: unknown) {
  mockStoryNodes.set(nodeId, node);
}

interface MockStoryNode {
  userId: string;
  documentId: string;
  stylePreset?: string | null;
  stylePrompt?: string | null;
}

mock.module('../../services/graph/graph.service', () => ({
  graphService: {
    __isMocked: true,
    connect: async () => {},
    disconnect: async () => {},
    getConnectionStatus: () => true,
    query: async () => ({ headers: [], data: [], stats: {} }),
    createStoryNode: async () => 'mock-node-id',
    getStoryNodeById: async (nodeId: string, userId: string) => {
      const node = mockStoryNodes.get(nodeId) as MockStoryNode | undefined;
      if (!node || node.userId !== userId) return null;
      return node;
    },
    getStoryNodeByIdInternal: async (nodeId: string) =>
      mockStoryNodes.get(nodeId) || null,
    getStoryNodesForDocument: async (documentId: string, userId: string) => {
      const nodes: unknown[] = [];
      for (const node of mockStoryNodes.values()) {
        const n = node as MockStoryNode;
        if (n.documentId === documentId && n.userId === userId) {
          nodes.push(node);
        }
      }
      return nodes;
    },
    updateStoryNode: async () => {},
    updateStoryNodeStyle: async (
      nodeId: string,
      stylePreset: string | null,
      stylePrompt: string | null,
    ) => {
      const node = mockStoryNodes.get(nodeId) as MockStoryNode | undefined;
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

async function createTestApp() {
  const [
    { default: adminRoutes },
    { default: authRoutes },
    { default: documentRoutes },
    { default: generationRoutes },
    { default: mediaRoutes },
    { default: nodeRoutes },
    { default: tagRoutes },
    { requireAuth, requireEmailVerified },
    { errorHandler },
    { requireAdmin },
  ] = await Promise.all([
    import('../../routes/admin'),
    import('../../routes/auth'),
    import('../../routes/documents'),
    import('../../routes/generations'),
    import('../../routes/media'),
    import('../../routes/nodes'),
    import('../../routes/tags'),
    import('../../middleware/auth'),
    import('../../middleware/errorHandler'),
    import('../../middleware/requireAdmin'),
  ]);

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
    }),
  );

  app.use(
    cors({
      origin: ['http://localhost:5173', 'http://localhost:3001'],
      credentials: true,
    }),
  );

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get(
    '/test/require-email-verified',
    requireAuth,
    requireEmailVerified(),
    (_req, res) => {
      res.json({ success: true });
    },
  );

  app.get(
    '/test/require-email-verified-custom',
    requireAuth,
    requireEmailVerified('Custom verification message'),
    (_req, res) => {
      res.json({ success: true });
    },
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

export async function startTestServer(): Promise<{
  app: Awaited<ReturnType<typeof createTestApp>>;
  port: number;
  baseUrl: string;
}> {
  const app = await createTestApp();

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const address = server.address();
      if (typeof address === 'object' && address !== null) {
        testServer.server = server;
        testServer.port = address.port;
        resolve({
          app,
          port: testServer.port,
          baseUrl: `http://127.0.0.1:${testServer.port}`,
        });
      } else {
        reject(new Error('Failed to get server address'));
      }
    });

    server.on('error', reject);
  });
}

export async function stopTestServer(): Promise<void> {
  if (testServer.server) {
    return new Promise((resolve) => {
      const server = testServer.server as { close: (cb: () => void) => void };
      server.close(() => {
        testServer.server = null;
        testServer.port = 0;
        resolve();
      });
    });
  }
}

const emailMock = getEmailServiceMock();

export { emailMock, mockStorageData, mockStoryNodes };
