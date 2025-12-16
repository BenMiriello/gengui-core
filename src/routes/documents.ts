import { Router, Request, Response, NextFunction } from 'express';
import { documentsService } from '../services/documents';
import { documentVersionsService } from '../services/documentVersions';
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
    const { content, title, version, cursorPosition } = req.body;

    if (version === undefined) {
      res.status(400).json({ error: { message: 'Version is required', code: 'INVALID_INPUT' } });
      return;
    }

    const document = await documentsService.update(
      id,
      userId,
      { content, title },
      version,
      cursorPosition
    );
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

router.get('/documents/:id/versions', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;
    await documentsService.get(id, userId);
    const versions = await documentVersionsService.list(id);
    res.json({ versions });
  } catch (error) {
    next(error);
  }
});

router.get('/documents/:id/versions/:versionId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { id, versionId } = req.params;
    await documentsService.get(id, userId);
    const version = await documentVersionsService.get(versionId, id);
    const content = await documentVersionsService.reconstructContent(id, versionId);
    res.json({ version: { ...version, content } });
  } catch (error) {
    next(error);
  }
});

router.post('/documents/:id/restore/:versionId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { id, versionId } = req.params;
    const document = await documentsService.get(id, userId);
    const content = await documentVersionsService.reconstructContent(id, versionId);
    const updated = await documentsService.update(
      id,
      userId,
      { content },
      document.version
    );
    res.json({ document: updated });
  } catch (error) {
    next(error);
  }
});

router.get('/documents/:id/versions/:versionId/children', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { id, versionId } = req.params;
    await documentsService.get(id, userId);
    const children = await documentVersionsService.getChildren(versionId);
    res.json({ children });
  } catch (error) {
    next(error);
  }
});

router.post('/documents/:id/set-version/:versionId', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { id, versionId } = req.params;
    const document = await documentsService.setCurrentVersion(id, userId, versionId);
    res.json({ document });
  } catch (error) {
    next(error);
  }
});

export default router;
