import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { and, eq, lt, or } from 'drizzle-orm';
import { db } from '../config/database';
import {
  emailVerificationTokens,
  passwordResetTokens,
  sessions,
  users,
} from '../models/schema';
import { ConflictError, UnauthorizedError } from '../utils/errors';
import { logger } from '../utils/logger';
import {
  validateEmail,
  validatePassword,
  validateUsername,
} from '../utils/validation';
import { emailService } from './emailService';
import { getImageProvider } from './image-generation/factory';

const BCRYPT_ROUNDS = 12;
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_VERIFICATION_DURATION_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_DURATION_MS = 60 * 60 * 1000;

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
        emailVerified: false,
      })
      .returning();

    const token = await this.createEmailVerificationToken(user.id, email);
    await emailService.sendVerificationEmail(email, token);

    logger.info({ userId: user.id, email, username }, 'User signed up');

    return {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      emailVerified: user.emailVerified,
    };
  }

  async login(emailOrUsername: string, password: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(
        or(
          eq(users.email, emailOrUsername),
          eq(users.username, emailOrUsername),
        ),
      )
      .limit(1);

    if (!user || !user.passwordHash) {
      throw new UnauthorizedError('Invalid credentials');
    }

    const now = new Date();

    if (user.lockedUntil && user.lockedUntil > now) {
      const minutesRemaining = Math.ceil(
        (user.lockedUntil.getTime() - now.getTime()) / (1000 * 60),
      );
      throw new UnauthorizedError(
        `Account locked. Try again in ${minutesRemaining} minute${minutesRemaining !== 1 ? 's' : ''}.`,
      );
    }

    if (user.failedLoginAttempts === 5) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } else if (user.failedLoginAttempts === 6) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);

    if (!validPassword) {
      const newAttempts = user.failedLoginAttempts + 1;
      const attemptsRemaining = Math.max(0, 8 - newAttempts);

      if (newAttempts >= 7) {
        const lockedUntil = new Date(now.getTime() + 15 * 60 * 1000);
        await db
          .update(users)
          .set({ failedLoginAttempts: newAttempts, lockedUntil })
          .where(eq(users.id, user.id));

        logger.warn(
          { userId: user.id, attempts: newAttempts },
          'Account locked due to failed login attempts',
        );
        throw new UnauthorizedError(
          'Too many failed attempts. Account locked for 15 minutes.',
        );
      } else {
        await db
          .update(users)
          .set({ failedLoginAttempts: newAttempts })
          .where(eq(users.id, user.id));

        if (newAttempts >= 5) {
          let message = `Invalid credentials. ${attemptsRemaining} attempt${attemptsRemaining !== 1 ? 's' : ''} remaining.`;
          if (newAttempts === 5) {
            message += ' Next attempt delayed 2 seconds.';
          } else if (newAttempts === 6) {
            message += ' Next attempt delayed 5 seconds.';
          }
          throw new UnauthorizedError(message);
        } else {
          throw new UnauthorizedError('Invalid credentials');
        }
      }
    }

    await db
      .update(users)
      .set({ failedLoginAttempts: 0, lockedUntil: null })
      .where(eq(users.id, user.id));

    logger.info({ userId: user.id }, 'User logged in');

    return {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      emailVerified: user.emailVerified ?? false,
    };
  }

  async createSession(userId: string, ipAddress?: string, userAgent?: string) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

    const [session] = await db
      .insert(sessions)
      .values({
        userId,
        token,
        expiresAt,
        lastActivityAt: new Date(),
        ipAddress: ipAddress || null,
        userAgent: userAgent || null,
      })
      .returning();

    logger.info(
      { userId, sessionId: session.id, ipAddress, userAgent },
      'Session created',
    );

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
      role: user.role,
      emailVerified: user.emailVerified ?? false,
      createdAt: user.createdAt?.toISOString() ?? new Date().toISOString(),
      pendingEmail: user.pendingEmail ?? null,
      defaultImageWidth: user.defaultImageWidth ?? 1024,
      defaultImageHeight: user.defaultImageHeight ?? 1024,
      defaultStylePreset: user.defaultStylePreset ?? null,
      hiddenPresetIds: user.hiddenPresetIds ?? [],
    };
  }

  async deleteSession(token: string) {
    await db.delete(sessions).where(eq(sessions.token, token));
    logger.info('Session deleted');
  }

  async deleteAllUserSessions(userId: string) {
    await db.delete(sessions).where(eq(sessions.userId, userId));
    logger.info({ userId }, 'All user sessions deleted');
  }

  async updateUsername(userId: string, username: string) {
    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      throw new ConflictError(usernameValidation.error!);
    }

    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);

    if (existingUser.length > 0 && existingUser[0].id !== userId) {
      throw new ConflictError('Username already taken');
    }

    const [user] = await db
      .update(users)
      .set({ username })
      .where(eq(users.id, userId))
      .returning();

    logger.info({ userId, newUsername: username }, 'Username updated');

    return {
      id: user.id,
      email: user.email,
      username: user.username,
    };
  }

  async updateEmail(userId: string, email: string) {
    if (!validateEmail(email)) {
      throw new ConflictError('Invalid email format');
    }

    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (existingUser.length > 0 && existingUser[0].id !== userId) {
      throw new ConflictError('Email already in use');
    }

    const [user] = await db
      .update(users)
      .set({ email })
      .where(eq(users.id, userId))
      .returning();

    logger.info({ userId, newEmail: email }, 'Email updated');

    return {
      id: user.id,
      email: user.email,
      username: user.username,
    };
  }

  async updatePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user || !user.passwordHash) {
      throw new UnauthorizedError('User not found');
    }

    const validPassword = await bcrypt.compare(
      currentPassword,
      user.passwordHash,
    );
    if (!validPassword) {
      throw new UnauthorizedError('Current password is incorrect');
    }

    const isSamePassword = await bcrypt.compare(newPassword, user.passwordHash);
    if (isSamePassword) {
      throw new ConflictError(
        'New password must be different from current password',
      );
    }

    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.valid) {
      throw new ConflictError(passwordValidation.errors.join(', '));
    }

    const newPasswordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    await db
      .update(users)
      .set({ passwordHash: newPasswordHash })
      .where(eq(users.id, userId));

    // Invalidate all sessions for security
    await this.deleteAllUserSessions(userId);

    await emailService.sendPasswordChangedEmail(user.email);

    logger.info({ userId }, 'Password updated and sessions invalidated');
  }

  async createEmailVerificationToken(
    userId: string,
    email: string,
  ): Promise<string> {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_DURATION_MS);

    await db.insert(emailVerificationTokens).values({
      userId,
      token,
      email,
      expiresAt,
    });

    logger.info({ userId, email }, 'Email verification token created');

    return token;
  }

  async verifyEmail(token: string) {
    await db
      .delete(emailVerificationTokens)
      .where(and(lt(emailVerificationTokens.expiresAt, new Date())));

    const [tokenRecord] = await db
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.token, token))
      .limit(1);

    if (!tokenRecord) {
      throw new UnauthorizedError('Invalid or expired verification token');
    }

    const [user] = await db
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, tokenRecord.userId))
      .returning();

    await db
      .delete(emailVerificationTokens)
      .where(eq(emailVerificationTokens.userId, tokenRecord.userId));

    logger.info({ userId: user.id, email: user.email }, 'Email verified');

    return {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      emailVerified: user.emailVerified,
    };
  }

  async resendVerificationEmail(userId: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) throw new UnauthorizedError('User not found');
    if (user.emailVerified) {
      return {
        success: true,
        alreadyVerified: true,
        message: 'Email already verified',
      };
    }

    // Delete old tokens, create new one
    await db
      .delete(emailVerificationTokens)
      .where(eq(emailVerificationTokens.userId, userId));
    const token = await this.createEmailVerificationToken(userId, user.email);
    await emailService.sendVerificationEmail(user.email, token);

    logger.info({ userId, email: user.email }, 'Verification email resent');
    return { success: true, alreadyVerified: false };
  }

  async updateUsernameWithPassword(
    userId: string,
    username: string,
    password: string,
  ) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user || !user.passwordHash) {
      throw new UnauthorizedError('User not found');
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      throw new UnauthorizedError('Current password is incorrect');
    }

    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      throw new ConflictError(usernameValidation.error!);
    }

    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);

    if (existingUser.length > 0 && existingUser[0].id !== userId) {
      throw new ConflictError('Username already taken');
    }

    const [updatedUser] = await db
      .update(users)
      .set({ username })
      .where(eq(users.id, userId))
      .returning();

    logger.info({ userId, newUsername: username }, 'Username updated');

    return {
      id: updatedUser.id,
      email: updatedUser.email,
      username: updatedUser.username,
      role: updatedUser.role,
      emailVerified: updatedUser.emailVerified,
    };
  }

  async initiateEmailChange(
    userId: string,
    newEmail: string,
    password: string,
  ) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user || !user.passwordHash) {
      throw new UnauthorizedError('User not found');
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      throw new UnauthorizedError('Current password is incorrect');
    }

    if (!validateEmail(newEmail)) {
      throw new ConflictError('Invalid email format');
    }

    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.email, newEmail))
      .limit(1);

    if (existingUser.length > 0 && existingUser[0].id !== userId) {
      throw new ConflictError('Email already in use');
    }

    await db
      .update(users)
      .set({ pendingEmail: newEmail })
      .where(eq(users.id, userId));

    const token = await this.createEmailVerificationToken(userId, newEmail);
    await emailService.sendEmailChangeVerification(newEmail, token);

    logger.info({ userId, newEmail }, 'Email change initiated');

    return { success: true };
  }

  async verifyEmailChange(token: string) {
    await db
      .delete(emailVerificationTokens)
      .where(and(lt(emailVerificationTokens.expiresAt, new Date())));

    const [tokenRecord] = await db
      .select()
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.token, token))
      .limit(1);

    if (!tokenRecord) {
      throw new UnauthorizedError('Invalid or expired verification token');
    }

    const [user] = await db
      .update(users)
      .set({
        email: tokenRecord.email,
        emailVerified: true,
        pendingEmail: null,
      })
      .where(eq(users.id, tokenRecord.userId))
      .returning();

    await db
      .delete(emailVerificationTokens)
      .where(eq(emailVerificationTokens.userId, tokenRecord.userId));

    // Invalidate all sessions for security
    await this.deleteAllUserSessions(tokenRecord.userId);

    logger.info(
      { userId: user.id, email: user.email },
      'Email changed, verified, and sessions invalidated',
    );

    return {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      emailVerified: user.emailVerified,
    };
  }

  async getUserPreferences(userId: string) {
    const [user] = await db
      .select({
        defaultImageWidth: users.defaultImageWidth,
        defaultImageHeight: users.defaultImageHeight,
        defaultStylePreset: users.defaultStylePreset,
        hiddenPresetIds: users.hiddenPresetIds,
        nodeTypeStyleDefaults: users.nodeTypeStyleDefaults,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw new UnauthorizedError('User not found');
    }

    return {
      ...user,
      hiddenPresetIds: user.hiddenPresetIds || [],
      nodeTypeStyleDefaults: user.nodeTypeStyleDefaults || null,
    };
  }

  async updateUserPreferences(
    userId: string,
    preferences: {
      defaultImageWidth?: number;
      defaultImageHeight?: number;
      defaultStylePreset?: string;
      hiddenPresetIds?: string[];
      nodeTypeStyleDefaults?: Record<
        string,
        { presetId: string; prompt?: string }
      > | null;
    },
  ) {
    const updates: any = {};

    if (preferences.defaultImageWidth !== undefined) {
      updates.defaultImageWidth = preferences.defaultImageWidth;
    }
    if (preferences.defaultImageHeight !== undefined) {
      updates.defaultImageHeight = preferences.defaultImageHeight;
    }
    if (preferences.defaultStylePreset !== undefined) {
      updates.defaultStylePreset = preferences.defaultStylePreset;
    }
    if (preferences.hiddenPresetIds !== undefined) {
      updates.hiddenPresetIds = preferences.hiddenPresetIds;
    }
    if (preferences.nodeTypeStyleDefaults !== undefined) {
      updates.nodeTypeStyleDefaults = preferences.nodeTypeStyleDefaults;
    }

    if (Object.keys(updates).length === 0) {
      throw new ConflictError('No preferences to update');
    }

    // Validate dimensions if both are being updated
    if (
      updates.defaultImageWidth !== undefined &&
      updates.defaultImageHeight !== undefined
    ) {
      const provider = await getImageProvider();
      if (
        !provider.validateDimensions(
          updates.defaultImageWidth,
          updates.defaultImageHeight,
        )
      ) {
        const supportedDimensions = provider.getSupportedDimensions();
        let dimensionsStr: string;
        if (Array.isArray(supportedDimensions)) {
          dimensionsStr = supportedDimensions
            .map((d) => `${d.width}x${d.height}`)
            .join(', ');
        } else {
          const { min, max, step } = supportedDimensions;
          dimensionsStr = `${min}-${max}px (step: ${step})`;
        }
        throw new ConflictError(
          `Dimensions ${updates.defaultImageWidth}x${updates.defaultImageHeight} not supported by ${provider.name} provider. Supported sizes: ${dimensionsStr}`,
        );
      }
    }

    const [user] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, userId))
      .returning({
        defaultImageWidth: users.defaultImageWidth,
        defaultImageHeight: users.defaultImageHeight,
        defaultStylePreset: users.defaultStylePreset,
        hiddenPresetIds: users.hiddenPresetIds,
        nodeTypeStyleDefaults: users.nodeTypeStyleDefaults,
      });

    logger.info({ userId, updates }, 'User preferences updated');

    return {
      ...user,
      hiddenPresetIds: user.hiddenPresetIds || [],
      nodeTypeStyleDefaults: user.nodeTypeStyleDefaults || null,
    };
  }

  async requestPasswordReset(email: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user) {
      logger.warn({ email }, 'Password reset requested for non-existent email');
      return;
    }

    await db
      .delete(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, user.id));

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_DURATION_MS);

    await db.insert(passwordResetTokens).values({
      userId: user.id,
      token,
      expiresAt,
    });

    await emailService.sendPasswordResetEmail(email, token);

    logger.info({ userId: user.id, email }, 'Password reset token created');
  }

  async resetPassword(token: string, newPassword: string) {
    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.valid) {
      throw new ConflictError(passwordValidation.errors.join(', '));
    }

    const [resetToken] = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.token, token))
      .limit(1);

    if (!resetToken) {
      throw new UnauthorizedError('Invalid or expired reset token');
    }

    if (resetToken.expiresAt < new Date()) {
      await db
        .delete(passwordResetTokens)
        .where(eq(passwordResetTokens.id, resetToken.id));
      throw new UnauthorizedError('Reset token expired, request a new one');
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    await db
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, resetToken.userId));

    await db
      .delete(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, resetToken.userId));

    await db.delete(sessions).where(eq(sessions.userId, resetToken.userId));

    logger.info({ userId: resetToken.userId }, 'Password reset completed');
  }
}

export const authService = new AuthService();
