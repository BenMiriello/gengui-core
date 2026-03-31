import { createHmac } from 'node:crypto';
import {
  type NextFunction,
  type Request,
  type Response,
  Router,
} from 'express';
import { env } from '../config/env';
import { passport } from '../config/passport';
import { requireAuth } from '../middleware/auth';
import {
  authRateLimiter,
  emailVerificationRateLimiter,
  passwordResetRateLimiter,
  signupRateLimiter,
} from '../middleware/rateLimiter';
import { analytics } from '../services/analytics';
import { authService } from '../services/auth';
import { oauthService } from '../services/auth/oauth';
import type { OAuthProfile } from '../services/auth/oauth.types';
import { usageService } from '../services/usage';
import { logger } from '../utils/logger';

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const LINK_STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

interface LinkState {
  userId: string;
  ts: number;
  action: 'link';
}

function signState(payload: string, secret: string): string {
  const signature = createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function verifyState(signed: string, secret: string): string | null {
  const lastDot = signed.lastIndexOf('.');
  if (lastDot === -1) return null;
  const payload = signed.substring(0, lastDot);
  const signature = signed.substring(lastDot + 1);
  const expected = createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');
  if (signature !== expected) return null;
  return payload;
}

const router = Router();

router.post(
  '/auth/signup',
  signupRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, username, password } = req.body;

      if (!email || !username || !password) {
        res.status(400).json({
          error: {
            message: 'Email, username, and password are required',
            code: 'INVALID_INPUT',
          },
        });
        return;
      }

      const user = await authService.signup(email, username, password);
      const ipAddress =
        req.ip || (req.headers['x-forwarded-for'] as string) || undefined;
      const userAgent = req.headers['user-agent'];
      const session = await authService.createSession(
        user.id,
        ipAddress,
        userAgent,
      );

      res.cookie('sessionToken', session.token, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: ONE_WEEK_MS,
      });

      analytics.track(user.id, 'auth_signup_server', { method: 'email' });
      res.status(201).json({ user });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/auth/login',
  authRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { emailOrUsername, password } = req.body;

      if (!emailOrUsername || !password) {
        res.status(400).json({
          error: {
            message: 'Email/username and password are required',
            code: 'INVALID_INPUT',
          },
        });
        return;
      }

      const user = await authService.login(emailOrUsername, password);
      const ipAddress =
        req.ip || (req.headers['x-forwarded-for'] as string) || undefined;
      const userAgent = req.headers['user-agent'];
      const session = await authService.createSession(
        user.id,
        ipAddress,
        userAgent,
      );

      res.cookie('sessionToken', session.token, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: ONE_WEEK_MS,
      });

      analytics.track(user.id, 'auth_login_server', { method: 'email' });
      res.json({ user });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/auth/logout',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = req.cookies.sessionToken;

      if (token) {
        await authService.deleteSession(token);
      }

      res.clearCookie('sessionToken');
      res.json({ success: true });
    } catch (error) {
      return next(error);
    }
  },
);

router.get(
  '/auth/me',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({
        user: req.user,
        sessionId: req.sessionId,
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.get(
  '/auth/me/usage',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const usage = await usageService.getUserUsage(req.user?.id as string);
      res.json(usage);
    } catch (error) {
      return next(error);
    }
  },
);

router.patch(
  '/auth/username',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id as string;
      const { username, password } = req.body;

      if (!username || !password) {
        res.status(400).json({
          error: {
            message: 'Username and password are required',
            code: 'INVALID_INPUT',
          },
        });
        return;
      }

      const user = await authService.updateUsernameWithPassword(
        userId,
        username,
        password,
      );
      res.json({ user });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/auth/email/initiate-change',
  requireAuth,
  emailVerificationRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id as string;
      const { email, password } = req.body;

      if (!email || !password) {
        res.status(400).json({
          error: {
            message: 'Email and password are required',
            code: 'INVALID_INPUT',
          },
        });
        return;
      }

      const result = await authService.initiateEmailChange(
        userId,
        email,
        password,
      );
      res.json(result);
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/auth/email/confirm-change',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = req.body;

      if (!token) {
        res.status(400).json({
          error: { message: 'Token is required', code: 'INVALID_INPUT' },
        });
        return;
      }

      const user = await authService.verifyEmailChange(token);
      res.json({ user });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/auth/verify-email',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = req.body;

      if (!token) {
        res.status(400).json({
          error: { message: 'Token is required', code: 'INVALID_INPUT' },
        });
        return;
      }

      const user = await authService.verifyEmail(token);
      res.json({ user });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/auth/resend-verification',
  requireAuth,
  emailVerificationRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await authService.resendVerificationEmail(
        req.user?.id as string,
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  '/auth/password',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id as string;
      const { currentPassword, newPassword } = req.body;

      if (!currentPassword || !newPassword) {
        res.status(400).json({
          error: {
            message: 'Current password and new password are required',
            code: 'INVALID_INPUT',
          },
        });
        return;
      }

      await authService.updatePassword(userId, currentPassword, newPassword);
      res.json({ success: true });
    } catch (error) {
      return next(error);
    }
  },
);

router.get(
  '/auth/preferences',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id as string;
      const preferences = await authService.getUserPreferences(userId);
      res.json({ preferences });
    } catch (error) {
      return next(error);
    }
  },
);

router.patch(
  '/auth/preferences',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id as string;
      const {
        defaultImageWidth,
        defaultImageHeight,
        defaultStylePreset,
        hiddenPresetIds,
        nodeTypeStyleDefaults,
      } = req.body;

      const preferences = await authService.updateUserPreferences(userId, {
        defaultImageWidth,
        defaultImageHeight,
        defaultStylePreset,
        hiddenPresetIds,
        nodeTypeStyleDefaults,
      });

      res.json({ preferences });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/auth/password-reset/request',
  passwordResetRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }

      await authService.requestPasswordReset(email);

      return res.json({ success: true });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/auth/password-reset/confirm',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token, password } = req.body;

      if (!token || !password) {
        return res
          .status(400)
          .json({ error: 'Token and password are required' });
      }

      await authService.resetPassword(token, password);

      return res.json({ success: true });
    } catch (error) {
      return next(error);
    }
  },
);

router.get(
  '/auth/google',
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    session: false,
  }),
);

router.get('/auth/google/link', requireAuth, (req: Request, res: Response) => {
  const userId = req.user?.id as string;
  const state: LinkState = {
    userId,
    ts: Date.now(),
    action: 'link',
  };
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
  const signedState = signState(payload, env.COOKIE_SECRET as string);

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID as string,
    redirect_uri: env.GOOGLE_CALLBACK_URL as string,
    response_type: 'code',
    scope: 'profile email',
    state: signedState,
    access_type: 'online',
    prompt: 'select_account',
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get(
  '/auth/google/callback',
  (req: Request, res: Response, next: NextFunction) => {
    const stateParam = req.query.state as string | undefined;

    // Check if this is a link action with signed state
    if (stateParam?.includes('.')) {
      const payload = verifyState(stateParam, env.COOKIE_SECRET as string);

      if (!payload) {
        logger.warn(
          { event: 'oauth_link_invalid_state' },
          'Invalid OAuth link state signature',
        );
        return res.redirect(`${env.FRONTEND_URL}/account?error=invalid_state`);
      }

      let linkState: LinkState;
      try {
        linkState = JSON.parse(Buffer.from(payload, 'base64url').toString());
      } catch {
        logger.warn(
          { event: 'oauth_link_malformed_state' },
          'Malformed OAuth link state',
        );
        return res.redirect(`${env.FRONTEND_URL}/account?error=invalid_state`);
      }

      if (linkState.action !== 'link') {
        return next();
      }

      // Check expiry
      if (Date.now() - linkState.ts > LINK_STATE_MAX_AGE_MS) {
        logger.warn(
          { event: 'oauth_link_expired', userId: linkState.userId },
          'OAuth link state expired',
        );
        return res.redirect(`${env.FRONTEND_URL}/account?error=state_expired`);
      }

      // Store link context for after passport authentication
      req.linkContext = linkState;
    }

    next();
  },
  passport.authenticate('google', {
    session: false,
    failureRedirect: '/login?error=oauth_failed',
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Handle link action: link to the specified user regardless of email
      if (req.linkContext) {
        const { userId } = req.linkContext;
        const profile = (req.authInfo as Record<string, unknown>)
          ?.pendingProfile as OAuthProfile | undefined;

        if (!profile) {
          // If passport already matched by email, use req.user profile info
          if (req.user) {
            // User already exists with matching email - check if it's the same user
            if (req.user.id === userId) {
              // Same user, already linked or will be linked
              const ipAddress =
                req.ip ||
                (req.headers['x-forwarded-for'] as string) ||
                undefined;
              const userAgent = req.headers['user-agent'];
              const session = await authService.createSession(
                req.user.id,
                ipAddress,
                userAgent,
              );

              res.cookie('sessionToken', session.token, {
                httpOnly: true,
                secure: env.NODE_ENV === 'production',
                sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
                maxAge: ONE_WEEK_MS,
              });

              return res.redirect(`${env.FRONTEND_URL}/account`);
            }
            // Different user - the Google account is linked to someone else
            logger.warn(
              {
                event: 'oauth_link_different_user',
                requestedUserId: userId,
                existingUserId: req.user.id,
              },
              'Attempted to link Google account already linked to different user',
            );
            return res.redirect(
              `${env.FRONTEND_URL}/account?error=already_linked`,
            );
          }
          logger.error(
            { event: 'oauth_link_no_profile' },
            'No profile available for link',
          );
          return res.redirect(`${env.FRONTEND_URL}/account?error=oauth_failed`);
        }

        try {
          await oauthService.linkOAuthByUserId(userId, profile);

          const ipAddress =
            req.ip || (req.headers['x-forwarded-for'] as string) || undefined;
          const userAgent = req.headers['user-agent'];
          const session = await authService.createSession(
            userId,
            ipAddress,
            userAgent,
          );

          res.cookie('sessionToken', session.token, {
            httpOnly: true,
            secure: env.NODE_ENV === 'production',
            sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
            maxAge: ONE_WEEK_MS,
          });

          logger.info(
            { event: 'oauth_link_success', userId },
            'OAuth account linked successfully',
          );
          return res.redirect(`${env.FRONTEND_URL}/account`);
        } catch (error) {
          if (error instanceof Error) {
            if (error.message.includes('already linked to another user')) {
              return res.redirect(
                `${env.FRONTEND_URL}/account?error=already_linked`,
              );
            }
            if (error.message.includes('Account already linked')) {
              return res.redirect(
                `${env.FRONTEND_URL}/account?error=already_has_oauth`,
              );
            }
            if (error.message.includes('User not found')) {
              return res.redirect(
                `${env.FRONTEND_URL}/account?error=user_not_found`,
              );
            }
          }
          throw error;
        }
      }

      // Standard OAuth flow (not a link action)
      if (!req.user) {
        const pendingProfile = (req.authInfo as Record<string, unknown>)
          ?.pendingProfile;

        res.cookie('pendingOAuthProfile', JSON.stringify(pendingProfile), {
          httpOnly: true,
          secure: env.NODE_ENV === 'production',
          signed: true,
          maxAge: 10 * 60 * 1000,
        });

        if (!env.FRONTEND_URL) {
          logger.error('FRONTEND_URL not set in environment');
          return res.status(500).json({ error: 'Server configuration error' });
        }
        return res.redirect(`${env.FRONTEND_URL}/auth/link-confirm`);
      }

      const ipAddress =
        req.ip || (req.headers['x-forwarded-for'] as string) || undefined;
      const userAgent = req.headers['user-agent'];
      const session = await authService.createSession(
        req.user.id,
        ipAddress,
        userAgent,
      );

      res.cookie('sessionToken', session.token, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: ONE_WEEK_MS,
      });

      if (!env.FRONTEND_URL) {
        logger.error('FRONTEND_URL not set in environment');
        return res.status(500).json({ error: 'Server configuration error' });
      }
      return res.redirect(env.FRONTEND_URL);
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/auth/link-google-with-password',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { password } = req.body;
      const pendingProfile = req.signedCookies.pendingOAuthProfile;

      if (!pendingProfile) {
        return res.status(400).json({
          error: 'NO_PENDING_OAUTH_PROFILE',
        });
      }

      if (!password) {
        return res.status(400).json({
          error: 'PASSWORD_REQUIRED',
        });
      }

      const profile = JSON.parse(pendingProfile) as OAuthProfile;
      const user = await oauthService.linkWithPasswordConfirmation(
        profile.email,
        password,
        profile,
      );

      res.clearCookie('pendingOAuthProfile');

      const ipAddress =
        req.ip || (req.headers['x-forwarded-for'] as string) || undefined;
      const userAgent = req.headers['user-agent'];
      const session = await authService.createSession(
        user.id,
        ipAddress,
        userAgent,
      );

      res.cookie('sessionToken', session.token, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: ONE_WEEK_MS,
      });

      return res.json({ user });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/auth/set-password',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id as string;
      const { password } = req.body;

      if (!password) {
        return res.status(400).json({ error: 'PASSWORD_REQUIRED' });
      }

      await authService.setPasswordForOAuthUser(userId, password);

      return res.json({ success: true });
    } catch (error) {
      return next(error);
    }
  },
);

router.delete(
  '/auth/account',
  requireAuth,
  authRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id as string;
      const { password, confirmationEmail } = req.body;

      if (!password && !confirmationEmail) {
        return res.status(400).json({
          error: {
            message: 'Password or email confirmation is required',
            code: 'INVALID_INPUT',
          },
        });
      }

      const result = await authService.initiateAccountDeletion(userId, {
        password,
        confirmationEmail,
      });

      res.clearCookie('sessionToken');
      return res.json({
        success: true,
        scheduledDeletionAt: result.scheduledDeletionAt.toISOString(),
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  '/auth/account/cancel-deletion',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id as string;
      await authService.cancelAccountDeletion(userId);
      return res.json({ success: true });
    } catch (error) {
      return next(error);
    }
  },
);

router.delete(
  '/auth/oauth',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.id as string;
      const { password } = req.body;

      if (!password) {
        return res.status(400).json({
          error: {
            message: 'Password is required',
            code: 'INVALID_INPUT',
          },
        });
      }

      await authService.unlinkOAuth(userId, password);
      res.clearCookie('sessionToken');
      return res.json({ success: true });
    } catch (error) {
      return next(error);
    }
  },
);

export default router;
