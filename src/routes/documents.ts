import { Router, Request, Response, NextFunction } from 'express';
import { documentsService } from '../services/documents';
import { mediaService } from '../services/mediaService';
import { sseService } from '../services/sse';
import { presenceService } from '../services/presence';
import { requireAuth } from '../middleware/auth';
import { redisStreams } from '../services/redis-streams';
import { db } from '../config/database';
import { storyNodes, storyNodeConnections } from '../models/schema';
import { eq, and, or, inArray } from 'drizzle-orm';

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

    const document = await documentsService.get(id, userId);
    console.log(`[GET /documents/${id}] DB fetch took ${Date.now() - start}ms`);

    res.json({
      document,
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
      contentJson,
      title,
      defaultStylePreset,
      defaultStylePrompt,
      defaultImageWidth,
      defaultImageHeight,
    } = req.body;

    const document = await documentsService.update(
      id,
      userId,
      {
        content,
        contentJson,
        title,
        defaultStylePreset,
        defaultStylePrompt,
        defaultImageWidth,
        defaultImageHeight,
      }
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

router.post('/documents/:id/analyze', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;
    const reanalyze = req.query.reanalyze === 'true';

    // Verify user owns document
    await documentsService.get(id, userId);

    // Queue analysis request
    await redisStreams.add('text-analysis:stream', {
      documentId: id,
      userId,
      reanalyze: reanalyze ? 'true' : 'false',
    });

    res.status(202).json({ message: 'Analysis queued' });
  } catch (error) {
    next(error);
  }
});

router.get('/documents/:id/story-nodes', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;

    // Verify user owns document
    await documentsService.get(id, userId);

    // Fetch story nodes
    const nodes = await db
      .select()
      .from(storyNodes)
      .where(and(eq(storyNodes.documentId, id), eq(storyNodes.userId, userId)));

    // Fetch connections for these nodes
    const nodeIds = nodes.map(n => n.id);
    const connections = nodeIds.length > 0
      ? await db
          .select()
          .from(storyNodeConnections)
          .where(
            or(
              inArray(storyNodeConnections.fromNodeId, nodeIds),
              inArray(storyNodeConnections.toNodeId, nodeIds)
            )
          )
      : [];

    res.json({ nodes, connections });
  } catch (error) {
    next(error);
  }
});

export default router;
