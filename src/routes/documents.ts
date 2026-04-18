import {
  type NextFunction,
  type Request,
  type Response,
  Router,
} from 'express';
import multer from 'multer';
import { jobService } from '../jobs/service';
import { requireAuth } from '../middleware/auth';
import { reconcileDocumentOnLoad } from '../services/analysisReconciliation';
import { documentsService } from '../services/documents';
import {
  computeCausalOrder,
  detectThreads,
  findCausalGaps,
  findPivotalNodes,
} from '../services/graph/graph.analysis';
import { graphService } from '../services/graph/graph.service';
import { graphThreads } from '../services/graph/graph.threads';
import { mediaService } from '../services/mediaService';
import {
  getPdfSignedUrl,
  importPdfDocument,
} from '../services/pdf/pdfImport.service';
import { entityDocumentSimilarityService } from '../services/semantics/entityDocumentSimilarity.service';
import { sseService } from '../services/sse';
import { versioningService } from '../services/versioning';
import { parseStringParam } from '../utils/validation';

const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are accepted'));
    }
  },
});

const router = Router();

router.get(
  '/documents',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const documents = await documentsService.list(userId);
      res.json({ documents });
    } catch (error) {
      next(error);
    }
  },
);

// IMPORTANT: /documents/trash must come BEFORE /documents/:id
// Otherwise Express matches "trash" as an :id parameter
router.get(
  '/documents/trash',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const documents = await documentsService.listDeleted(userId);
      res.json({ documents });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const document = await documentsService.get(id, userId);

      // Fire-and-forget drift check against analysis service; never blocks
      // document open even if the analysis service is unavailable
      reconcileDocumentOnLoad(id).catch(() => {});

      res.json({ document });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/documents',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const { title, content } = req.body;

      if (content === undefined) {
        res.status(400).json({
          error: { message: 'Content is required', code: 'INVALID_INPUT' },
        });
        return;
      }

      const document = await documentsService.create(
        userId,
        title,
        content || '',
      );

      await sseService.broadcastToUser(userId, 'document-updated', {
        documentId: document.id,
        currentVersion: 1,
        updatedAt: document.createdAt,
      });

      res.status(201).json({ document });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/documents/:id/copy',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const { title } = req.body;
      const document = await documentsService.copy(
        id,
        userId,
        title || 'Untitled',
      );

      await sseService.broadcastToUser(userId, 'document-updated', {
        documentId: document.id,
        currentVersion: 1,
        updatedAt: document.createdAt,
      });

      res.status(201).json({ document });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/documents/import/pdf',
  requireAuth,
  pdfUpload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      if (!req.file) {
        res.status(400).json({
          error: { message: 'No PDF file provided', code: 'INVALID_INPUT' },
        });
        return;
      }

      const result = await importPdfDocument(
        req.user.id,
        req.file.buffer,
        req.file.originalname,
      );

      await sseService.broadcastToUser(req.user.id, 'document-updated', {
        documentId: result.documentId,
        currentVersion: 0,
        updatedAt: new Date().toISOString(),
      });

      res.status(201).json({
        document: {
          id: result.documentId,
          title: result.title,
          pageCount: result.pageCount,
        },
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id/file-url',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const id = parseStringParam(req.params.id, 'id');
      const document = await documentsService.get(id, req.user.id);

      if (document.documentType !== 'pdf' || !document.fileKey) {
        res.status(404).json({
          error: {
            message: 'Document has no associated file',
            code: 'NOT_FOUND',
          },
        });
        return;
      }

      const url = await getPdfSignedUrl(document.fileKey);
      res.json({ url });
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  '/documents/:id',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const {
        content,
        yjsState,
        title,
        defaultStylePreset,
        defaultStylePrompt,
        defaultImageWidth,
        defaultImageHeight,
        analysisModeEnabled,
        mediaModeEnabled,
        expectedVersion,
        forceOverwrite,
      } = req.body;

      const document = await documentsService.update(id, userId, {
        content,
        yjsState,
        title,
        defaultStylePreset,
        defaultStylePrompt,
        defaultImageWidth,
        defaultImageHeight,
        analysisModeEnabled,
        mediaModeEnabled,
        expectedVersion,
        forceOverwrite,
      });

      await sseService.broadcastToDocument(id, 'document-updated', {
        documentId: document.id,
        currentVersion: document.currentVersion,
        updatedAt: document.updatedAt,
      });

      res.json({ document });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id/versions',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const limit = parseInt(req.query.limit as string, 10) || 50;

      await documentsService.get(id, userId);
      const versions = await versioningService.getVersions(id, limit);
      res.json({ versions });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id/versions/:versionNumber',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const versionNumber = parseStringParam(
        req.params.versionNumber,
        'versionNumber',
      );

      await documentsService.get(id, userId);
      const version = await versioningService.getVersion(
        id,
        parseInt(versionNumber, 10),
      );

      if (!version) {
        res
          .status(404)
          .json({ error: { message: 'Version not found', code: 'NOT_FOUND' } });
        return;
      }

      res.json({ version });
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  '/documents/:id/modes',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const { analysisModeEnabled, mediaModeEnabled } = req.body;

      const document = await documentsService.update(id, userId, {
        analysisModeEnabled,
        mediaModeEnabled,
      });
      res.json({ document });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  '/documents/:id',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');

      // Cancel any active analysis before deleting
      const activeJob = await jobService.getActiveForTarget(
        'document_analysis',
        id,
      );
      if (activeJob) {
        await jobService.updateStatus(activeJob.id, 'cancelled');
      }

      await sseService.broadcastToDocument(id, 'document-deleted', {
        documentId: id,
      });

      await documentsService.delete(id, userId);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/documents/:id/restore',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const document = await documentsService.restore(id, userId);
      res.json({ document });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id/info',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const info = await documentsService.getDeletedInfo(id, userId);
      res.json(info);
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  '/documents/:id/permanent',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const { deleteMedia } = req.body || {};
      await documentsService.permanentDelete(id, userId, { deleteMedia });
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id/media/deleted',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const media = await mediaService.getDeletedDocumentMedia(id, userId);
      res.json({ media });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id/media',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      await documentsService.get(id, userId);
      const media = await mediaService.getDocumentMedia(id);
      res.json({ media });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  '/documents/:id/media',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      await documentsService.get(id, userId);
      const count = await mediaService.softDeleteDocumentMedia(id, userId);
      res.json({ message: 'Media soft deleted', count });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/documents/:id/media/restore',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      await documentsService.get(id, userId);
      const count = await mediaService.restoreDocumentMedia(id, userId);
      res.json({ message: 'Media restored', count });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id/node-similarities',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const k = parseInt(req.query.k as string, 10) || 10;
      const cutoff = parseFloat(req.query.cutoff as string) || 0.3;

      await documentsService.get(id, userId);

      const similarities = await graphService.getNodeSimilaritiesForDocument(
        id,
        userId,
        k,
        cutoff,
      );

      res.json({ similarities });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id/graph-analysis',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');

      await documentsService.get(id, userId);

      const [causalOrder, threads, pivotalNodes, causalGaps] =
        await Promise.all([
          computeCausalOrder(id, userId),
          detectThreads(id, userId),
          findPivotalNodes(id, userId),
          findCausalGaps(id, userId),
        ]);

      const existingThreads = await graphThreads.getThreadsForDocument(
        id,
        userId,
      );

      const existingThreadsWithMembers = await Promise.all(
        existingThreads.map(async (thread) => {
          const memberships = await graphThreads.getEventsForThread(thread.id);
          return {
            ...thread,
            memberNodeIds: memberships.map((m) => m.eventId),
          };
        }),
      );

      res.json({
        causalOrder,
        detectedThreads: threads,
        existingThreads: existingThreadsWithMembers,
        pivotalNodes,
        causalGaps,
      });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id/node-layout-projection',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');

      await documentsService.get(id, userId);

      const projection = await graphService.getNodeEmbeddingsProjection(
        id,
        userId,
      );

      res.json({ projection });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/documents/:id/entity-similarity/:entityId',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const entityId = parseStringParam(req.params.entityId, 'entityId');

      await documentsService.get(id, userId);

      const result =
        await entityDocumentSimilarityService.computeEntitySimilarityForDocument(
          id,
          entityId,
          userId,
        );

      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

// Entity arc endpoint
router.get(
  '/documents/:id/entity-arc/:entityId',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const entityId = parseStringParam(req.params.entityId, 'entityId');

      // Verify user has access to document
      await documentsService.get(id, userId);

      const [arcs, transitions] = await Promise.all([
        graphService.getEntityArcs(entityId),
        graphService.getStateTransitions(entityId),
      ]);

      // For each arc, get its states via INCLUDES_STATE
      const arcsWithStates = await Promise.all(
        arcs.map(async (arc) => {
          const arcStates = await graphService.getArcStatesForArc(arc.id);
          return {
            id: arc.id,
            name: arc.name,
            arcType: arc.arcType,
            states: arcStates.map((s) => ({
              id: s.id,
              name: s.name,
              description: '', // States don't have description, use name
              documentOrder: s.documentOrder,
            })),
            transitions: transitions
              .filter((t) => arcStates.some((s) => s.id === t.fromStateId))
              .map((t) => ({
                fromStateId: t.fromStateId,
                toStateId: t.toStateId,
                gapDetected: t.gapDetected,
                triggerEventId: t.triggerEventId,
              })),
          };
        }),
      );

      res.json({ entityId, arcs: arcsWithStates });
    } catch (error) {
      next(error);
    }
  },
);

// Arc entity IDs endpoint — lightweight query for which entities have real arc data
router.get(
  '/documents/:id/arc-entity-ids',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');

      await documentsService.get(id, userId);

      const entityIds = await graphService.getEntityIdsWithArcs(id);
      res.json({ entityIds });
    } catch (error) {
      next(error);
    }
  },
);

// Thread management endpoints

router.post(
  '/documents/:id/threads',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');
      const { name, isPrimary } = req.body;

      await documentsService.get(id, userId);

      const threadId = await graphService.createThread(id, userId, {
        name: name || 'Untitled Thread',
        isPrimary: isPrimary ?? false,
        eventNames: [],
      });

      res.status(201).json({ threadId });
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  '/threads/:id',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseStringParam(req.params.id, 'id');
      const { name } = req.body;

      const thread = await graphThreads.getThreadById(id);
      if (!thread) {
        res
          .status(404)
          .json({ error: { message: 'Thread not found', code: 'NOT_FOUND' } });
        return;
      }

      if (name) await graphThreads.renameThread(id, name);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  '/threads/:id',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseStringParam(req.params.id, 'id');

      const thread = await graphThreads.getThreadById(id);
      if (!thread) {
        res
          .status(404)
          .json({ error: { message: 'Thread not found', code: 'NOT_FOUND' } });
        return;
      }

      await graphThreads.deleteThread(id);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/threads/:id/members',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseStringParam(req.params.id, 'id');
      const { nodeId, order } = req.body;

      await graphThreads.addEventToThread(nodeId, id, order ?? 0);
      res.status(201).json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  '/threads/:id/members/:nodeId',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = parseStringParam(req.params.id, 'id');
      const nodeId = parseStringParam(req.params.nodeId, 'nodeId');

      await graphThreads.removeEventFromThread(nodeId, id);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/documents/:id/detect-threads',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw new Error('User not authenticated');
      const userId = req.user.id;
      const id = parseStringParam(req.params.id, 'id');

      await documentsService.get(id, userId);
      const threads = await detectThreads(id, userId);

      res.json({ threads });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
