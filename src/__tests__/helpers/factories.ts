import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { sql } from 'drizzle-orm';
import type { Express } from 'express';
import { getTestDb } from './setup';

const BCRYPT_ROUNDS = 12;

let mediaCounter = 0;
let tagCounter = 0;
// Note: processPrefix is defined with userCounter to prevent collision across parallel test files

interface UserInsert {
  email?: string;
  username?: string;
  password?: string;
  emailVerified?: boolean;
  role?: 'user' | 'admin';
}

interface TestUser {
  id: string;
  email: string;
  username: string;
  role: 'user' | 'admin';
  emailVerified: boolean;
}

let userCounter = 0;
// Process-unique prefix to prevent collisions when tests run in parallel
const processPrefix = `${process.pid}_${Date.now().toString(36)}`;

function generateUniqueId() {
  return `${processPrefix}_${++userCounter}`;
}

export async function createTestUser(
  overrides: UserInsert = {}
): Promise<{ user: TestUser; password: string }> {
  const db = await getTestDb();
  const uniqueId = generateUniqueId();

  const email = overrides.email ?? `testuser${uniqueId}@example.com`;
  const username = overrides.username ?? `testuser${uniqueId}`;
  const password = overrides.password ?? 'TestPassword123!';
  const emailVerified = overrides.emailVerified ?? false;
  const role = overrides.role ?? 'user';

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const result = await db.execute(sql`
    INSERT INTO users (email, username, password_hash, email_verified, role)
    VALUES (${email}, ${username}, ${passwordHash}, ${emailVerified}, ${role})
    RETURNING id, email, username, role, email_verified
  `);

  const row = result[0] as any;

  return {
    user: {
      id: row.id,
      email: row.email,
      username: row.username,
      role: row.role,
      emailVerified: row.email_verified,
    },
    password,
  };
}

export async function createVerifiedUser(
  overrides: UserInsert = {}
): Promise<{ user: TestUser; password: string }> {
  return createTestUser({ ...overrides, emailVerified: true });
}

export async function createAdminUser(
  overrides: UserInsert = {}
): Promise<{ user: TestUser; password: string }> {
  return createTestUser({ ...overrides, role: 'admin', emailVerified: true });
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const db = await getTestDb();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await db.execute(sql`
    INSERT INTO sessions (user_id, token, expires_at)
    VALUES (${userId}, ${token}, ${expiresAt.toISOString()})
  `);

  return { token, expiresAt };
}

export async function loginAs(
  app: Express,
  emailOrUsername: string,
  password: string
): Promise<string> {
  const response = await fetch(
    `http://127.0.0.1:${(app as any).address?.()?.port || 0}/api/auth/login`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailOrUsername, password }),
    }
  );

  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error('No session cookie returned from login');
  }

  return setCookie;
}

export async function getAuthCookie(
  app: Express,
  user: TestUser,
  password: string
): Promise<string> {
  return loginAs(app, user.email, password);
}

export function resetUserCounter() {
  userCounter = 0;
}

export async function createEmailVerificationToken(userId: string, email: string): Promise<string> {
  const db = await getTestDb();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await db.execute(sql`
    INSERT INTO email_verification_tokens (user_id, token, email, expires_at)
    VALUES (${userId}, ${token}, ${email}, ${expiresAt.toISOString()})
  `);

  return token;
}

export async function createExpiredEmailVerificationToken(
  userId: string,
  email: string
): Promise<string> {
  const db = await getTestDb();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() - 1000);

  await db.execute(sql`
    INSERT INTO email_verification_tokens (user_id, token, email, expires_at)
    VALUES (${userId}, ${token}, ${email}, ${expiresAt.toISOString()})
  `);

  return token;
}

export async function createPasswordResetToken(userId: string): Promise<string> {
  const db = await getTestDb();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  await db.execute(sql`
    INSERT INTO password_reset_tokens (user_id, token, expires_at)
    VALUES (${userId}, ${token}, ${expiresAt.toISOString()})
  `);

  return token;
}

export async function createExpiredPasswordResetToken(userId: string): Promise<string> {
  const db = await getTestDb();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() - 1000);

  await db.execute(sql`
    INSERT INTO password_reset_tokens (user_id, token, expires_at)
    VALUES (${userId}, ${token}, ${expiresAt.toISOString()})
  `);

  return token;
}

export async function createExpiredSession(
  userId: string
): Promise<{ token: string; expiresAt: Date }> {
  const db = await getTestDb();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() - 1000);

  await db.execute(sql`
    INSERT INTO sessions (user_id, token, expires_at)
    VALUES (${userId}, ${token}, ${expiresAt.toISOString()})
  `);

  return { token, expiresAt };
}

export async function getUserFromDb(userId: string) {
  const db = await getTestDb();
  const result = await db.execute(sql`
    SELECT * FROM users WHERE id = ${userId}
  `);
  return result[0] as any;
}

export async function getSessionsForUser(userId: string) {
  const db = await getTestDb();
  const result = await db.execute(sql`
    SELECT * FROM sessions WHERE user_id = ${userId}
  `);
  return result as any[];
}

export async function getEmailVerificationTokensForUser(userId: string) {
  const db = await getTestDb();
  const result = await db.execute(sql`
    SELECT * FROM email_verification_tokens WHERE user_id = ${userId}
  `);
  return result as any[];
}

export async function getPasswordResetTokensForUser(userId: string) {
  const db = await getTestDb();
  const result = await db.execute(sql`
    SELECT * FROM password_reset_tokens WHERE user_id = ${userId}
  `);
  return result as any[];
}

interface DocumentInsert {
  title?: string;
  content?: string;
  narrativeModeEnabled?: boolean;
  mediaModeEnabled?: boolean;
}

interface TestDocument {
  id: string;
  userId: string;
  title: string;
  content: string;
  narrativeModeEnabled: boolean;
  mediaModeEnabled: boolean;
  currentVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

let documentCounter = 0;

export async function createTestDocument(
  userId: string,
  overrides: DocumentInsert = {}
): Promise<TestDocument> {
  const db = await getTestDb();
  const uniqueId = ++documentCounter;

  const title = overrides.title ?? `Test Document ${uniqueId}`;
  const content = overrides.content ?? `This is test content for document ${uniqueId}.`;
  const narrativeModeEnabled = overrides.narrativeModeEnabled ?? false;
  const mediaModeEnabled = overrides.mediaModeEnabled ?? false;

  const result = await db.execute(sql`
    INSERT INTO documents (user_id, title, content, narrative_mode_enabled, media_mode_enabled, segment_sequence)
    VALUES (${userId}, ${title}, ${content}, ${narrativeModeEnabled}, ${mediaModeEnabled}, '[]'::jsonb)
    RETURNING id, user_id, title, content, narrative_mode_enabled, media_mode_enabled, current_version, created_at, updated_at
  `);

  const row = result[0] as any;

  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    content: row.content,
    narrativeModeEnabled: row.narrative_mode_enabled,
    mediaModeEnabled: row.media_mode_enabled,
    currentVersion: row.current_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getDocumentsForUser(userId: string) {
  const db = await getTestDb();
  const result = await db.execute(sql`
    SELECT * FROM documents WHERE user_id = ${userId} AND deleted_at IS NULL
    ORDER BY updated_at DESC
  `);
  return result as any[];
}

export async function getDocumentById(documentId: string) {
  const db = await getTestDb();
  const result = await db.execute(sql`
    SELECT * FROM documents WHERE id = ${documentId}
  `);
  return result[0] as any;
}

export async function getDocumentVersions(documentId: string) {
  const db = await getTestDb();
  const result = await db.execute(sql`
    SELECT * FROM document_versions WHERE document_id = ${documentId}
    ORDER BY version_number DESC
  `);
  return result as any[];
}

export function resetDocumentCounter() {
  documentCounter = 0;
}

// ========== Media Factories ==========

interface MediaInsert {
  storageKey?: string;
  s3Key?: string;
  size?: number;
  mimeType?: string;
  hash?: string;
  generated?: boolean;
  status?: string;
  sourceType?: string;
}

interface TestMedia {
  id: string;
  userId: string;
  storageKey: string | null;
  s3Key: string | null;
  size: number | null;
  mimeType: string | null;
  hash: string | null;
  generated: boolean;
  status: string;
  createdAt: Date;
}

export async function createTestMedia(
  userId: string,
  overrides: MediaInsert = {}
): Promise<TestMedia> {
  const db = await getTestDb();
  const uniqueId = ++mediaCounter;

  const storageKey = overrides.storageKey ?? `${userId}/media-${uniqueId}/1`;
  const s3Key = overrides.s3Key ?? storageKey;
  const size = overrides.size ?? 1024;
  const mimeType = overrides.mimeType ?? 'image/png';
  const hash = overrides.hash ?? crypto.randomBytes(32).toString('hex');
  const generated = overrides.generated ?? false;
  const status = overrides.status ?? 'completed';
  const sourceType = overrides.sourceType ?? 'upload';

  const result = await db.execute(sql`
    INSERT INTO media (user_id, storage_key, s3_key, size, mime_type, hash, generated, status, source_type)
    VALUES (${userId}, ${storageKey}, ${s3Key}, ${size}, ${mimeType}, ${hash}, ${generated}, ${status}, ${sourceType})
    RETURNING id, user_id, storage_key, s3_key, size, mime_type, hash, generated, status, created_at
  `);

  const row = result[0] as any;

  return {
    id: row.id,
    userId: row.user_id,
    storageKey: row.storage_key,
    s3Key: row.s3_key,
    size: row.size,
    mimeType: row.mime_type,
    hash: row.hash,
    generated: row.generated,
    status: row.status,
    createdAt: row.created_at,
  };
}

export async function getMediaForUser(userId: string) {
  const db = await getTestDb();
  const result = await db.execute(sql`
    SELECT * FROM media WHERE user_id = ${userId} AND deleted_at IS NULL
    ORDER BY created_at DESC
  `);
  return result as any[];
}

export async function getMediaById(mediaId: string) {
  const db = await getTestDb();
  const result = await db.execute(sql`
    SELECT * FROM media WHERE id = ${mediaId}
  `);
  return result[0] as any;
}

export function resetMediaCounter() {
  mediaCounter = 0;
}

// ========== Tag Factories ==========

interface TestTag {
  id: string;
  userId: string;
  name: string;
  createdAt: Date;
}

export async function createTestTag(userId: string, name?: string): Promise<TestTag> {
  const db = await getTestDb();
  const uniqueId = ++tagCounter;
  const tagName = name ?? `tag-${uniqueId}`;

  const result = await db.execute(sql`
    INSERT INTO tags (user_id, name)
    VALUES (${userId}, ${tagName})
    RETURNING id, user_id, name, created_at
  `);

  const row = result[0] as any;

  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    createdAt: row.created_at,
  };
}

export async function getTagsForUser(userId: string) {
  const db = await getTestDb();
  const result = await db.execute(sql`
    SELECT * FROM tags WHERE user_id = ${userId}
    ORDER BY name
  `);
  return result as any[];
}

export async function addTagToMedia(mediaId: string, tagId: string) {
  const db = await getTestDb();
  await db.execute(sql`
    INSERT INTO media_tags (media_id, tag_id)
    VALUES (${mediaId}, ${tagId})
  `);
}

export async function getMediaTags(mediaId: string) {
  const db = await getTestDb();
  const result = await db.execute(sql`
    SELECT t.* FROM tags t
    INNER JOIN media_tags mt ON t.id = mt.tag_id
    WHERE mt.media_id = ${mediaId}
  `);
  return result as any[];
}

export function resetTagCounter() {
  tagCounter = 0;
}

// ========== Generation Factories ==========

let generationCounter = 0;

interface GenerationInsert {
  prompt?: string;
  seed?: number;
  width?: number;
  height?: number;
  status?: string;
  documentId?: string;
}

interface TestGeneration {
  id: string;
  userId: string;
  prompt: string;
  seed: number;
  width: number;
  height: number;
  status: string;
  createdAt: Date;
}

export async function createTestGeneration(
  userId: string,
  overrides: GenerationInsert = {}
): Promise<TestGeneration> {
  const db = await getTestDb();
  const uniqueId = ++generationCounter;

  const prompt = overrides.prompt ?? `Test prompt ${uniqueId}`;
  const seed = overrides.seed ?? Math.floor(Math.random() * 1000000);
  const width = overrides.width ?? 1024;
  const height = overrides.height ?? 1024;
  const status = overrides.status ?? 'queued';

  const result = await db.execute(sql`
    INSERT INTO media (user_id, source_type, status, prompt, seed, width, height)
    VALUES (${userId}, 'generation', ${status}, ${prompt}, ${seed}, ${width}, ${height})
    RETURNING id, user_id, prompt, seed, width, height, status, created_at
  `);

  const row = result[0] as any;

  const generation: TestGeneration = {
    id: row.id,
    userId: row.user_id,
    prompt: row.prompt,
    seed: row.seed,
    width: row.width,
    height: row.height,
    status: row.status,
    createdAt: row.created_at,
  };

  if (overrides.documentId) {
    await db.execute(sql`
      INSERT INTO document_media (document_id, media_id)
      VALUES (${overrides.documentId}, ${generation.id})
    `);
  }

  return generation;
}

export async function createQueuedGeneration(
  userId: string,
  overrides: Omit<GenerationInsert, 'status'> = {}
): Promise<TestGeneration> {
  return createTestGeneration(userId, { ...overrides, status: 'queued' });
}

export async function createCompletedGeneration(
  userId: string,
  overrides: Omit<GenerationInsert, 'status'> = {}
): Promise<TestGeneration> {
  return createTestGeneration(userId, { ...overrides, status: 'completed' });
}

export async function createFailedGeneration(
  userId: string,
  overrides: Omit<GenerationInsert, 'status'> = {}
): Promise<TestGeneration> {
  return createTestGeneration(userId, { ...overrides, status: 'failed' });
}

export async function createCancelledGeneration(
  userId: string,
  overrides: Omit<GenerationInsert, 'status'> = {}
): Promise<TestGeneration> {
  const db = await getTestDb();
  const generation = await createTestGeneration(userId, { ...overrides, status: 'failed' });

  await db.execute(sql`
    UPDATE media SET cancelled_at = NOW(), error = 'Cancelled by user'
    WHERE id = ${generation.id}
  `);

  return generation;
}

export async function getGenerationsForUser(userId: string) {
  const db = await getTestDb();
  const result = await db.execute(sql`
    SELECT * FROM media
    WHERE user_id = ${userId}
    AND source_type = 'generation'
    AND deleted_at IS NULL
    ORDER BY created_at DESC
  `);
  return result as any[];
}

export async function getGenerationById(generationId: string) {
  const db = await getTestDb();
  const result = await db.execute(sql`
    SELECT * FROM media WHERE id = ${generationId}
  `);
  return result[0] as any;
}

export function resetGenerationCounter() {
  generationCounter = 0;
}
