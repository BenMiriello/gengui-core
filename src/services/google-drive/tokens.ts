import { eq } from 'drizzle-orm';
import { db } from '../../config/database';
import { env } from '../../config/env';
import { users } from '../../models/schema';
import { logger } from '../../utils/logger';
import { decrypt, encrypt } from '../encryption';
import type { DriveConnectionStatus } from './types';

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export async function storeTokens(
  userId: string,
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
): Promise<void> {
  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  const tokensJson = JSON.stringify({ accessToken, refreshToken });
  const { ciphertext, iv, tag } = encrypt(tokensJson);

  await db
    .update(users)
    .set({
      googleAccessToken: ciphertext,
      googleRefreshToken: refreshToken ? ciphertext : null,
      googleTokenExpiry: expiresAt,
      googleTokenIv: iv,
      googleTokenTag: tag,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));

  logger.info({ userId, expiresAt }, 'Google Drive tokens stored');
}

export async function getValidAccessToken(
  userId: string,
): Promise<string | null> {
  const [user] = await db
    .select({
      googleAccessToken: users.googleAccessToken,
      googleTokenExpiry: users.googleTokenExpiry,
      googleTokenIv: users.googleTokenIv,
      googleTokenTag: users.googleTokenTag,
    })
    .from(users)
    .where(eq(users.id, userId));

  if (!user?.googleAccessToken || !user.googleTokenIv || !user.googleTokenTag) {
    return null;
  }

  const isExpired =
    user.googleTokenExpiry &&
    new Date(user.googleTokenExpiry).getTime() <
      Date.now() + TOKEN_REFRESH_BUFFER_MS;

  if (isExpired) {
    return refreshAccessToken(userId);
  }

  try {
    const decrypted = decrypt(
      user.googleAccessToken,
      user.googleTokenIv,
      user.googleTokenTag,
    );
    const tokens = JSON.parse(decrypted) as {
      accessToken: string;
      refreshToken: string;
    };
    return tokens.accessToken;
  } catch (error) {
    logger.error({ userId, error }, 'Failed to decrypt Google access token');
    return null;
  }
}

export async function refreshAccessToken(
  userId: string,
): Promise<string | null> {
  const [user] = await db
    .select({
      googleAccessToken: users.googleAccessToken,
      googleTokenIv: users.googleTokenIv,
      googleTokenTag: users.googleTokenTag,
    })
    .from(users)
    .where(eq(users.id, userId));

  if (!user?.googleAccessToken || !user.googleTokenIv || !user.googleTokenTag) {
    return null;
  }

  let refreshToken: string;
  try {
    const decrypted = decrypt(
      user.googleAccessToken,
      user.googleTokenIv,
      user.googleTokenTag,
    );
    const tokens = JSON.parse(decrypted) as {
      accessToken: string;
      refreshToken: string;
    };
    refreshToken = tokens.refreshToken;
  } catch (error) {
    logger.error({ userId, error }, 'Failed to decrypt refresh token');
    return null;
  }

  if (!refreshToken) {
    logger.warn({ userId }, 'No refresh token available');
    return null;
  }

  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    logger.error({ userId }, 'Google OAuth not configured for token refresh');
    return null;
  }

  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      logger.error(
        { userId, status: response.status, error: errorData },
        'Token refresh failed',
      );
      await clearTokens(userId);
      return null;
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };

    await storeTokens(
      userId,
      data.access_token,
      data.refresh_token || refreshToken,
      data.expires_in,
    );

    return data.access_token;
  } catch (error) {
    logger.error({ userId, error }, 'Error refreshing Google token');
    return null;
  }
}

export async function clearTokens(userId: string): Promise<void> {
  await db
    .update(users)
    .set({
      googleAccessToken: null,
      googleRefreshToken: null,
      googleTokenExpiry: null,
      googleTokenIv: null,
      googleTokenTag: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));

  logger.info({ userId }, 'Google Drive tokens cleared');
}

export async function hasValidConnection(userId: string): Promise<boolean> {
  const token = await getValidAccessToken(userId);
  return token !== null;
}

export async function getConnectionStatus(
  userId: string,
): Promise<DriveConnectionStatus> {
  const [user] = await db
    .select({
      googleAccessToken: users.googleAccessToken,
      googleTokenExpiry: users.googleTokenExpiry,
      googleTokenIv: users.googleTokenIv,
      googleTokenTag: users.googleTokenTag,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, userId));

  if (!user?.googleAccessToken) {
    return { connected: false };
  }

  const hasValidToken = await hasValidConnection(userId);

  return {
    connected: hasValidToken,
    email: hasValidToken ? user.email : undefined,
    expiresAt: user.googleTokenExpiry?.toISOString(),
  };
}
