import {
  type NextFunction,
  type Request,
  type Response,
  Router,
} from 'express';
import { contactService } from '../services/contact';

const router = Router();

router.post(
  '/contact',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { subject, message, submissionType } = req.body;
      const userId = req.user!.id;
      const email = req.user!.email || req.body.email;

      if (!email) {
        res.status(400).json({ error: 'Email required' });
        return;
      }

      if (!subject || !message) {
        res.status(400).json({ error: 'Subject and message required' });
        return;
      }

      const result = await contactService.submitContact({
        userId,
        email,
        subject,
        message,
        submissionType: submissionType || 'contact',
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip,
      });

      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

export default router;
