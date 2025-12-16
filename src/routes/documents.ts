import { Router, Request, Response, NextFunction } from 'express';
import { documentsService } from '../services/documents';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/documents', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const documents = await documentsService.list(userId);
    res.json({ documents });
  } catch (error) {
    next(error);
  }
});

router.get('/documents/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;
    const document = await documentsService.get(id, userId);
    res.json({ document });
  } catch (error) {
    next(error);
  }
});

router.post('/documents', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { title, content } = req.body;

    if (content === undefined) {
      res.status(400).json({ error: { message: 'Content is required', code: 'INVALID_INPUT' } });
      return;
    }

    const document = await documentsService.create(userId, title, content || '');
    res.status(201).json({ document });
  } catch (error) {
    next(error);
  }
});

router.patch('/documents/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;
    const { content, title, version } = req.body;

    if (version === undefined) {
      res.status(400).json({ error: { message: 'Version is required', code: 'INVALID_INPUT' } });
      return;
    }

    const document = await documentsService.update(id, userId, { content, title }, version);
    res.json({ document });
  } catch (error) {
    next(error);
  }
});

router.delete('/documents/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;
    await documentsService.delete(id, userId);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
