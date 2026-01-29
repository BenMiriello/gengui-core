import { Router, Request, Response, NextFunction } from 'express';
import { documentsService } from '../services/documents';
import { versioningService } from '../services/versioning';
import { mediaService } from '../services/mediaService';
import { sseService } from '../services/sse';
import { presenceService } from '../services/presence';
import { requireAuth } from '../middleware/auth';
import { redisStreams } from '../services/redis-streams';
import { db } from '../config/database';
import { storyNodes, storyNodeConnections, media } from '../models/schema';
import { eq, and, or, inArray, isNull } from 'drizzle-orm';
import { s3 } from '../services/s3';

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

router.post('/documents/:id/copy', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { title } = req.body;
    const document = await documentsService.copy(req.params.id, userId, title || 'Untitled');
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
      yjsState,
      title,
      defaultStylePreset,
      defaultStylePrompt,
      defaultImageWidth,
      defaultImageHeight,
      narrativeModeEnabled,
      mediaModeEnabled,
    } = req.body;

    const document = await documentsService.update(
      id,
      userId,
      {
        content,
        yjsState,
        title,
        defaultStylePreset,
        defaultStylePrompt,
        defaultImageWidth,
        defaultImageHeight,
        narrativeModeEnabled,
        mediaModeEnabled,
      }
    );
    res.json({ document });
  } catch (error) {
    next(error);
  }
});

router.get('/documents/:id/versions', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;

    await documentsService.get(id, userId);
    const versions = await versioningService.getVersions(id, limit);
    res.json({ versions });
  } catch (error) {
    next(error);
  }
});

router.get('/documents/:id/versions/:versionNumber', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { id, versionNumber } = req.params;

    await documentsService.get(id, userId);
    const version = await versioningService.getVersion(id, parseInt(versionNumber));

    if (!version) {
      res.status(404).json({ error: { message: 'Version not found', code: 'NOT_FOUND' } });
      return;
    }

    res.json({ version });
  } catch (error) {
    next(error);
  }
});

router.patch('/documents/:id/modes', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;
    const { narrativeModeEnabled, mediaModeEnabled } = req.body;

    const document = await documentsService.update(
      id,
      userId,
      {
        narrativeModeEnabled,
        mediaModeEnabled,
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
    sseService.addClient(clientId, `document:${id}`, res);
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

    sseService.addClient(clientId, `document:${id}`, res);
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

    // Fetch active story nodes (not soft deleted)
    const nodes = await db
      .select()
      .from(storyNodes)
      .where(
        and(
          eq(storyNodes.documentId, id),
          eq(storyNodes.userId, userId),
          isNull(storyNodes.deletedAt)
        )
      );

    // Fetch active connections for these nodes
    const nodeIds = nodes.map(n => n.id);
    const connections = nodeIds.length > 0
      ? await db
          .select()
          .from(storyNodeConnections)
          .where(
            and(
              or(
                inArray(storyNodeConnections.fromNodeId, nodeIds),
                inArray(storyNodeConnections.toNodeId, nodeIds)
              ),
              isNull(storyNodeConnections.deletedAt)
            )
          )
      : [];

    // Fetch primary media URLs for nodes that have them
    const nodesWithPrimaryMedia = nodes.filter(n => n.primaryMediaId);
    let primaryMediaUrls: Record<string, string> = {};

    if (nodesWithPrimaryMedia.length > 0) {
      const mediaIds = nodesWithPrimaryMedia.map(n => n.primaryMediaId!);
      const mediaRecords = await db
        .select({ id: media.id, s3KeyThumb: media.s3KeyThumb, s3Key: media.s3Key })
        .from(media)
        .where(inArray(media.id, mediaIds));

      // Generate presigned URLs for thumbnails (or full image if no thumb)
      for (const m of mediaRecords) {
        const key = m.s3KeyThumb || m.s3Key;
        if (key) {
          try {
            primaryMediaUrls[m.id] = await s3.generateDownloadUrl(key);
          } catch {
            // Skip if URL generation fails
          }
        }
      }
    }

    // Augment nodes with primaryMediaUrl
    const nodesWithUrls = nodes.map(n => ({
      ...n,
      primaryMediaUrl: n.primaryMediaId ? primaryMediaUrls[n.primaryMediaId] : null,
    }));

    res.json({ nodes: nodesWithUrls, connections });
  } catch (error) {
    next(error);
  }
});

router.patch('/documents/:id/story-nodes', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;

    // Verify user owns document
    await documentsService.get(id, userId);

    // Queue update request
    await redisStreams.add('text-analysis:stream', {
      documentId: id,
      userId,
      updateMode: 'true',
    });

    res.status(202).json({ message: 'Update queued' });
  } catch (error) {
    next(error);
  }
});

router.delete('/documents/:id/story-nodes', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;

    // Soft delete all story nodes for this document
    await db
      .update(storyNodes)
      .set({ deletedAt: new Date() })
      .where(and(eq(storyNodes.documentId, id), eq(storyNodes.userId, userId)));

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
