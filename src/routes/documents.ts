import { Router, Request, Response, NextFunction } from 'express';
import { documentsService } from '../services/documents';
import { documentVersionsService } from '../services/documentVersions';
import { mediaService } from '../services/mediaService';
import { sseService } from '../services/sse';
import { presenceService } from '../services/presence';
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
    const start = Date.now();
    const userId = (req as any).user.id;
    const { id } = req.params;
    const sessionId = req.sessionId!;

    const document = await documentsService.get(id, userId);
    console.log(`[GET /documents/${id}] DB fetch took ${Date.now() - start}ms`);

    const editorCount = await presenceService.getActiveEditorCount(id);
    const isPrimaryEditor = await presenceService.isPrimaryEditor(id, sessionId);
    const hasActiveEditor = editorCount > 0;

    res.json({
      document,
      hasActiveEditor,
      isPrimaryEditor,
    });
    console.log(`[GET /documents/${id}] Total request took ${Date.now() - start}ms`);
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
    const {
      content,
      title,
      version,
      cursorPosition,
      defaultStylePreset,
      defaultStylePrompt,
      defaultImageWidth,
      defaultImageHeight,
    } = req.body;

    if (version === undefined) {
      res.status(400).json({ error: { message: 'Version is required', code: 'INVALID_INPUT' } });
      return;
    }

    const document = await documentsService.update(
      id,
      userId,
      {
        content,
        title,
        defaultStylePreset,
        defaultStylePrompt,
        defaultImageWidth,
        defaultImageHeight,
      },
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
    const start = Date.now();
    const userId = (req as any).user.id;
    const { id, versionId } = req.params;
    const includeContent = req.query.includeContent === 'true';

    await documentsService.get(id, userId);
    const version = await documentVersionsService.get(versionId, id);

    if (includeContent) {
      const contentStart = Date.now();
      const content = await documentVersionsService.reconstructContent(id, versionId);
      console.log(`[GET /versions/${versionId.slice(0,8)}] Reconstruct took ${Date.now() - contentStart}ms`);
      res.json({ version: { ...version, content } });
    } else {
      res.json({ version });
    }
    console.log(`[GET /versions/${versionId.slice(0,8)}] Total ${Date.now() - start}ms`);
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
    const start = Date.now();
    const userId = (req as any).user.id;
    const { id, versionId } = req.params;
    await documentsService.get(id, userId);
    const children = await documentVersionsService.getChildren(versionId);
    res.json({ children });
    console.log(`[GET /versions/${versionId.slice(0,8)}/children] Total ${Date.now() - start}ms, found ${children.length} children`);
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

router.get('/documents/:id/media', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;
    await documentsService.get(id, userId);
    const media = await mediaService.getDocumentMedia(id);
    res.json({ media });
  } catch (error) {
    next(error);
  }
});

router.get('/documents/:id/media/stream', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;
    await documentsService.get(id, userId);

    const clientId = `${userId}-${id}-${Date.now()}`;
    sseService.addClient(clientId, id, res);
  } catch (error) {
    next(error);
  }
});

router.get('/documents/:id/stream', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;
    await documentsService.get(id, userId);

    const sessionId = req.headers['x-session-id'] as string || `${userId}-${Date.now()}`;
    const clientId = `doc-${id}-${sessionId}`;

    sseService.addClient(clientId, id, res);
  } catch (error) {
    next(error);
  }
});

router.put('/documents/:id/heartbeat', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;
    const sessionId = req.sessionId!;

    await documentsService.get(id, userId);
    await presenceService.recordHeartbeat(id, sessionId);

    const isPrimaryEditor = await presenceService.isPrimaryEditor(id, sessionId);
    if (isPrimaryEditor) {
      await presenceService.renewPrimaryLock(id, sessionId);
    } else {
      const currentPrimary = await presenceService.getPrimaryEditor(id);
      if (!currentPrimary) {
        await presenceService.attemptTakeover(id, sessionId);
      }
    }

    const editorCount = await presenceService.getActiveEditorCount(id);
    sseService.broadcastToDocument(id, 'presence-update', {
      editorCount,
      sessionId,
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

router.post('/documents/:id/takeover', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;
    const sessionId = req.sessionId!;

    await documentsService.get(id, userId);

    const success = await presenceService.attemptTakeover(id, sessionId);

    if (success) {
      res.json({ success: true, isPrimaryEditor: true });
    } else {
      res.status(409).json({
        error: {
          message: 'Another session just took over. Please try again.',
          code: 'TAKEOVER_CONFLICT',
        },
      });
    }
  } catch (error) {
    next(error);
  }
});

export default router;
