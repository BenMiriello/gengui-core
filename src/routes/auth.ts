import { Router, Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth';
import { requireAuth } from '../middleware/auth';
import { env } from '../config/env';

const router = Router();

router.post('/auth/signup', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, username, password } = req.body;

    if (!email || !username || !password) {
      res.status(400).json({
        error: { message: 'Email, username, and password are required', code: 'INVALID_INPUT' }
      });
      return;
    }

    const user = await authService.signup(email, username, password);
    const session = await authService.createSession(user.id);

    res.cookie('sessionToken', session.token, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(201).json({ user });
  } catch (error) {
    next(error);
  }
});

router.post('/auth/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { emailOrUsername, password } = req.body;

    if (!emailOrUsername || !password) {
      res.status(400).json({
        error: { message: 'Email/username and password are required', code: 'INVALID_INPUT' }
      });
      return;
    }

    const user = await authService.login(emailOrUsername, password);
    const session = await authService.createSession(user.id);

    res.cookie('sessionToken', session.token, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({ user });
  } catch (error) {
    next(error);
  }
});

router.post('/auth/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies.sessionToken;

    if (token) {
      await authService.deleteSession(token);
    }

    res.clearCookie('sessionToken');
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.get('/auth/me', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({
      user: req.user,
      sessionId: req.sessionId,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
