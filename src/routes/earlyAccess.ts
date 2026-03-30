import {
  type NextFunction,
  type Request,
  type Response,
  Router,
} from 'express';
import { earlyAccessRateLimiter } from '../middleware/rateLimiter';
import { earlyAccessService } from '../services/earlyAccess';
import { validateEmail } from '../utils/validation';

const router = Router();

router.post(
  '/early-access',
  earlyAccessRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email } = req.body;

      if (!email || !validateEmail(email)) {
        res.status(400).json({ error: 'Valid email required' });
        return;
      }

      const result = await earlyAccessService.signup({
        email,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

export default router;
