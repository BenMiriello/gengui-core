import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { env } from '../config/env';
import { requireAuth } from '../middleware/auth';
import {
  clearTokens,
  exportToDrive,
  GoogleDriveClient,
  getConnectionStatus,
  getValidAccessToken,
  importFromDrive,
  storeTokens,
} from '../services/google-drive';
import { logger } from '../utils/logger';

const router = Router();

const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
];

function getCallbackUrl(baseCallbackUrl: string): string {
  return baseCallbackUrl.replace(
    '/api/auth/google/callback',
    '/api/google-drive/callback',
  );
}

function getDriveOAuthUrl(
  clientId: string,
  callbackUrl: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: DRIVE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

router.get(
  '/google-drive/connect',
  requireAuth,
  (req: Request, res: Response) => {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL } = env;

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_CALLBACK_URL) {
      res.status(503).json({ error: 'Google OAuth not configured' });
      return;
    }

    if (!env.GOOGLE_TOKEN_ENCRYPTION_KEY) {
      res
        .status(503)
        .json({ error: 'Google Drive integration not configured' });
      return;
    }

    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const state = Buffer.from(
      JSON.stringify({ userId, ts: Date.now() }),
    ).toString('base64url');

    const callbackUrl = getCallbackUrl(GOOGLE_CALLBACK_URL);
    const authUrl = getDriveOAuthUrl(GOOGLE_CLIENT_ID, callbackUrl, state);
    res.redirect(authUrl);
  },
);

router.get(
  '/google-drive/callback',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { code, state, error } = req.query;

      if (error) {
        logger.warn({ error }, 'Google Drive OAuth error');
        return res.redirect(
          `${env.FRONTEND_URL}/account?drive=error&message=${encodeURIComponent(String(error))}`,
        );
      }

      if (!code || !state) {
        return res.redirect(
          `${env.FRONTEND_URL}/account?drive=error&message=missing_params`,
        );
      }

      let stateData: { userId: string; ts: number };
      try {
        stateData = JSON.parse(
          Buffer.from(String(state), 'base64url').toString(),
        );
      } catch {
        return res.redirect(
          `${env.FRONTEND_URL}/account?drive=error&message=invalid_state`,
        );
      }

      if (Date.now() - stateData.ts > 10 * 60 * 1000) {
        return res.redirect(
          `${env.FRONTEND_URL}/account?drive=error&message=state_expired`,
        );
      }

      const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL } =
        env;
      if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_CALLBACK_URL) {
        return res.redirect(
          `${env.FRONTEND_URL}/account?drive=error&message=not_configured`,
        );
      }

      const callbackUrl = getCallbackUrl(GOOGLE_CALLBACK_URL);

      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          code: String(code),
          grant_type: 'authorization_code',
          redirect_uri: callbackUrl,
        }),
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        logger.error(
          { status: tokenResponse.status, error: errorText },
          'Token exchange failed',
        );
        return res.redirect(
          `${env.FRONTEND_URL}/account?drive=error&message=token_exchange_failed`,
        );
      }

      const tokens = (await tokenResponse.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };

      if (!tokens.refresh_token) {
        logger.warn({ userId: stateData.userId }, 'No refresh token received');
      }

      await storeTokens(
        stateData.userId,
        tokens.access_token,
        tokens.refresh_token || '',
        tokens.expires_in,
      );

      logger.info({ userId: stateData.userId }, 'Google Drive connected');
      return res.redirect(`${env.FRONTEND_URL}/account?drive=connected`);
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/google-drive/disconnect',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const accessToken = await getValidAccessToken(userId);
      if (accessToken) {
        try {
          await fetch(
            `https://oauth2.googleapis.com/revoke?token=${accessToken}`,
            {
              method: 'POST',
            },
          );
        } catch (error) {
          logger.warn({ userId, error }, 'Failed to revoke Google token');
        }
      }

      await clearTokens(userId);

      res.json({ success: true });
    } catch (error) {
      return next(error);
    }
  },
);

router.get(
  '/google-drive/status',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const status = await getConnectionStatus(userId);

      if (status.connected) {
        const accessToken = await getValidAccessToken(userId);
        if (accessToken) {
          const client = new GoogleDriveClient(accessToken);
          const email = await client.getUserEmail();
          status.email = email || undefined;
        }
      }

      res.json(status);
    } catch (error) {
      return next(error);
    }
  },
);

router.get(
  '/google-drive/picker-token',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      if (!env.GOOGLE_PICKER_API_KEY) {
        res.status(503).json({ error: 'Google Picker not configured' });
        return;
      }

      const accessToken = await getValidAccessToken(userId);
      if (!accessToken) {
        res.status(400).json({ error: 'Google Drive not connected' });
        return;
      }

      const appId = env.GOOGLE_CLIENT_ID?.split('-')[0] || '';

      res.json({
        token: accessToken,
        developerKey: env.GOOGLE_PICKER_API_KEY,
        appId,
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/google-drive/import',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const { fileId } = req.body;
      if (!fileId || typeof fileId !== 'string') {
        res.status(400).json({ error: 'fileId is required' });
        return;
      }

      const result = await importFromDrive({ userId, fileId });
      res.json(result);
    } catch (error) {
      logger.error({ userId: req.user?.id, error }, 'Drive import failed');
      return next(error);
    }
  },
);

router.post(
  '/google-drive/export',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      const { documentId, folderId, format, filename, html, styles } = req.body;

      if (!documentId || !format || !filename || !html) {
        res.status(400).json({
          error: 'documentId, format, filename, and html are required',
        });
        return;
      }

      if (!['pdf', 'docx'].includes(format)) {
        res.status(400).json({ error: 'format must be pdf or docx' });
        return;
      }

      const result = await exportToDrive({
        userId,
        documentId,
        folderId: folderId || null,
        format,
        filename,
        html,
        styles,
      });

      res.json(result);
    } catch (error) {
      logger.error({ userId: req.user?.id, error }, 'Drive export failed');
      return next(error);
    }
  },
);

export default router;
