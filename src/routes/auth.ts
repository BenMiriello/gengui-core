import { type NextFunction, type Request, type Response, Router } from 'express';
import { env } from '../config/env';
import { requireAuth } from '../middleware/auth';
import {
  authRateLimiter,
  emailVerificationRateLimiter,
  passwordResetRateLimiter,
  signupRateLimiter,
} from '../middleware/rateLimiter';
import { authService } from '../services/auth';

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const router = Router();

router.post(
  '/auth/signup',
  signupRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, username, password } = req.body;

      if (!email || !username || !password) {
        res.status(400).json({
          error: { message: 'Email, username, and password are required', code: 'INVALID_INPUT' },
        });
        return;
      }

      const user = await authService.signup(email, username, password);
      const ipAddress = req.ip || (req.headers['x-forwarded-for'] as string) || undefined;
      const userAgent = req.headers['user-agent'];
      const session = await authService.createSession(user.id, ipAddress, userAgent);

      res.cookie('sessionToken', session.token, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: ONE_WEEK_MS,
      });

      res.status(201).json({ user });
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  '/auth/login',
  authRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { emailOrUsername, password } = req.body;

      if (!emailOrUsername || !password) {
        res.status(400).json({
          error: { message: 'Email/username and password are required', code: 'INVALID_INPUT' },
        });
        return;
      }

      const user = await authService.login(emailOrUsername, password);
      const ipAddress = req.ip || (req.headers['x-forwarded-for'] as string) || undefined;
      const userAgent = req.headers['user-agent'];
      const session = await authService.createSession(user.id, ipAddress, userAgent);

      res.cookie('sessionToken', session.token, {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: ONE_WEEK_MS,
      });

      res.json({ user });
    } catch (error) {
      return next(error);
    }
  }
);

router.post('/auth/logout', async (req: Request, res: Response, next: NextFunction) => {
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
});

router.get('/auth/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({
      user: req.user,
      sessionId: req.sessionId,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch(
  '/auth/username',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.id;
      const { username, password } = req.body;

      if (!username || !password) {
        res.status(400).json({
          error: { message: 'Username and password are required', code: 'INVALID_INPUT' },
        });
        return;
      }

      const user = await authService.updateUsernameWithPassword(userId, username, password);
      res.json({ user });
    } catch (error) {
      return next(error);
    }
  }
);

router.post(
  '/auth/email/initiate-change',
  requireAuth,
  emailVerificationRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.id;
      const { email, password } = req.body;

      if (!email || !password) {
        res.status(400).json({
          error: { message: 'Email and password are required', code: 'INVALID_INPUT' },
        });
        return;
      }

      const result = await authService.initiateEmailChange(userId, email, password);
      res.json(result);
    } catch (error) {
      return next(error);
    }
  }
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
  }
);

router.post('/auth/verify-email', async (req: Request, res: Response, next: NextFunction) => {
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
});

router.post(
  '/auth/resend-verification',
  requireAuth,
  emailVerificationRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await authService.resendVerificationEmail(req.user?.id);
      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

router.patch(
  '/auth/password',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.id;
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
  }
);

router.get(
  '/auth/preferences',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.id;
      const preferences = await authService.getUserPreferences(userId);
      res.json({ preferences });
    } catch (error) {
      return next(error);
    }
  }
);

router.patch(
  '/auth/preferences',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.id;
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
  }
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
  }
);

router.post(
  '/auth/password-reset/confirm',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token, password } = req.body;

      if (!token || !password) {
        return res.status(400).json({ error: 'Token and password are required' });
      }

      await authService.resetPassword(token, password);

      return res.json({ success: true });
    } catch (error) {
      return next(error);
    }
  }
);

export default router;
