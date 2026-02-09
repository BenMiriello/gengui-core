import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { sql } from 'drizzle-orm';
import type { Express } from 'express';
import { getTestDb } from './setup';

const BCRYPT_ROUNDS = 12;

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

function generateUniqueId() {
  return ++userCounter;
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
