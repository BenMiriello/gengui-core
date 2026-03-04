import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../../config/database';
import { users } from '../../models/schema';
import { ConflictError, UnauthorizedError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { validateUsername } from '../../utils/validation';
import type { OAuthProfile, OAuthUserLookupResult } from './oauth.types';

export class OAuthService {
  async determineAction(profile: OAuthProfile): Promise<OAuthUserLookupResult> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, profile.email))
      .limit(1);

    if (!user) {
      return { action: 'create' };
    }

    if (user.oauthProvider === profile.provider) {
      return {
        action: 'login',
        user: {
          id: user.id,
          email: user.email,
          emailVerified: user.emailVerified ?? false,
          passwordHash: user.passwordHash,
          oauthProvider: user.oauthProvider,
          oauthProviderId: user.oauthProviderId,
        },
      };
    }

    if (
      user.oauthProvider !== null &&
      user.oauthProvider !== profile.provider
    ) {
      throw new ConflictError(`Email already linked to ${user.oauthProvider}`);
    }

    if (user.emailVerified && profile.emailVerified) {
      return {
        action: 'link',
        user: {
          id: user.id,
          email: user.email,
          emailVerified: user.emailVerified,
          passwordHash: user.passwordHash,
          oauthProvider: user.oauthProvider,
          oauthProviderId: user.oauthProviderId,
        },
      };
    }

    return {
      action: 'confirm_password',
      user: {
        id: user.id,
        email: user.email,
        emailVerified: user.emailVerified ?? false,
        passwordHash: user.passwordHash,
        oauthProvider: user.oauthProvider,
        oauthProviderId: user.oauthProviderId,
      },
      reason: 'UNVERIFIED_EMAIL_REQUIRES_PASSWORD',
    };
  }

  async createOAuthUser(profile: OAuthProfile) {
    const username = await this.generateUniqueUsername(profile.email);

    const [user] = await db
      .insert(users)
      .values({
        email: profile.email,
        username,
        passwordHash: null,
        oauthProvider: profile.provider,
        oauthProviderId: profile.providerId,
        emailVerified: true,
      })
      .returning();

    logger.info(
      {
        userId: user.id,
        provider: profile.provider,
        event: 'oauth_signup',
      },
      'OAuth user created',
    );

    return {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt?.toISOString() ?? new Date().toISOString(),
      pendingEmail: user.pendingEmail ?? null,
      defaultImageWidth: user.defaultImageWidth ?? 1024,
      defaultImageHeight: user.defaultImageHeight ?? 1024,
      defaultStylePreset: user.defaultStylePreset ?? null,
      hiddenPresetIds: user.hiddenPresetIds ?? [],
      oauthProvider: user.oauthProvider ?? null,
      hasPassword: !!user.passwordHash,
    };
  }

  async linkOAuthToUser(userId: string, profile: OAuthProfile) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw new UnauthorizedError('User not found');
    }

    if (user.oauthProvider) {
      throw new ConflictError(
        `Account already linked to ${user.oauthProvider}`,
      );
    }

    await db
      .update(users)
      .set({
        oauthProvider: profile.provider,
        oauthProviderId: profile.providerId,
        emailVerified: true,
      })
      .where(eq(users.id, userId));

    logger.info(
      {
        userId,
        provider: profile.provider,
        event: 'oauth_linked',
      },
      'OAuth account linked',
    );
  }

  async linkWithPasswordConfirmation(
    email: string,
    password: string,
    profile: OAuthProfile,
  ) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user || !user.passwordHash) {
      throw new UnauthorizedError('Invalid credentials');
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      throw new UnauthorizedError('Invalid password');
    }

    await db
      .update(users)
      .set({
        oauthProvider: profile.provider,
        oauthProviderId: profile.providerId,
        emailVerified: true,
      })
      .where(eq(users.id, user.id));

    logger.info(
      {
        userId: user.id,
        provider: profile.provider,
        event: 'oauth_linked_with_password_confirmation',
      },
      'OAuth linked after password confirmation',
    );

    return {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      emailVerified: true,
      oauthProvider: profile.provider,
      hasPassword: false,
    };
  }

  private async generateUniqueUsername(email: string): Promise<string> {
    const localPart = email.split('@')[0];
    let username = localPart.toLowerCase().replace(/[^a-z0-9_]/g, '_');

    const validation = validateUsername(username);
    if (!validation.valid) {
      username = `user_${Math.random().toString(36).substring(2, 8)}`;
    }

    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);

    if (existingUser.length === 0) {
      return username;
    }

    const suffix = Math.floor(1000 + Math.random() * 9000);
    return `${username}${suffix}`;
  }
}

export const oauthService = new OAuthService();
