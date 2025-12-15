import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { db } from '../config/database';
import { users, sessions } from '../models/schema';
import { eq, or } from 'drizzle-orm';
import { validatePassword, validateUsername, validateEmail } from '../utils/validation';
import { ConflictError, UnauthorizedError } from '../utils/errors';
import { logger } from '../utils/logger';

const BCRYPT_ROUNDS = 12;
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export class AuthService {
  async signup(email: string, username: string, password: string) {
    if (!validateEmail(email)) {
      throw new ConflictError('Invalid email format');
    }

    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      throw new ConflictError(usernameValidation.error!);
    }

    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      throw new ConflictError(passwordValidation.errors.join(', '));
    }

    const existingUser = await db
      .select()
      .from(users)
      .where(or(eq(users.email, email), eq(users.username, username)))
      .limit(1);

    if (existingUser.length > 0) {
      if (existingUser[0].email === email) {
        throw new ConflictError('Email already in use');
      }
      throw new ConflictError('Username already taken');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const [user] = await db
      .insert(users)
      .values({
        email,
        username,
        passwordHash,
      })
      .returning();

    logger.info({ userId: user.id, email, username }, 'User signed up');

    return {
      id: user.id,
      email: user.email,
      username: user.username,
    };
  }

  async login(emailOrUsername: string, password: string) {
    const user = await db
      .select()
      .from(users)
      .where(
        or(
          eq(users.email, emailOrUsername),
          eq(users.username, emailOrUsername)
        )
      )
      .limit(1);

    if (user.length === 0 || !user[0].passwordHash) {
      throw new UnauthorizedError('Invalid credentials');
    }

    const validPassword = await bcrypt.compare(password, user[0].passwordHash);
    if (!validPassword) {
      throw new UnauthorizedError('Invalid credentials');
    }

    logger.info({ userId: user[0].id }, 'User logged in');

    return {
      id: user[0].id,
      email: user[0].email,
      username: user[0].username,
    };
  }

  async createSession(userId: string) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

    const [session] = await db
      .insert(sessions)
      .values({
        userId,
        token,
        expiresAt,
      })
      .returning();

    logger.info({ userId, sessionId: session.id }, 'Session created');

    return {
      token: session.token,
      expiresAt: session.expiresAt,
    };
  }

  async validateSession(token: string) {
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.token, token))
      .limit(1);

    if (!session) {
      return null;
    }

    if (new Date() > session.expiresAt) {
      await db.delete(sessions).where(eq(sessions.id, session.id));
      return null;
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    if (!user) {
      return null;
    }

    return {
      id: user.id,
      email: user.email,
      username: user.username,
    };
  }

  async deleteSession(token: string) {
    await db.delete(sessions).where(eq(sessions.token, token));
    logger.info('Session deleted');
  }
}

export const authService = new AuthService();
