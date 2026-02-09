import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../config/database';
import { requireAuth, requireEmailVerified } from '../middleware/auth';
import { documents } from '../models/schema';
import { characterSheetService } from '../services/characterSheetService';
import { graphService } from '../services/graph/graph.service';
import { mentionService } from '../services/mentions';
import { segmentService } from '../services/segments';
import { sseService } from '../services/sse';

const router = Router();

const characterSheetSettingsSchema = z.object({
  framing: z.enum(['portrait', 'full_body']).optional(),
  perspective: z.enum(['exterior', 'interior', 'custom']).optional(),
  perspectiveCustom: z.string().max(200).optional(),
  background: z.enum(['white', 'black', 'transparent', 'custom']).optional(),
  backgroundCustom: z.string().max(200).optional(),
  manualEdit: z.boolean(),
  customDescription: z.string().max(2000).optional(),
});

const generateCharacterSheetSchema = z.object({
  settings: characterSheetSettingsSchema,
  aspectRatio: z.enum(['portrait', 'square', 'landscape']).optional(),
  stylePreset: z.string().max(50).nullable().optional(),
  stylePrompt: z.string().max(2000).nullable().optional(),
});

const setPrimaryMediaSchema = z.object({
  mediaId: z.string().uuid(),
});

const updateNodeStyleSchema = z.object({
  stylePreset: z.string().max(50).nullable(),
  stylePrompt: z.string().max(2000).nullable(),
});

const updateNodeSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  aliases: z.array(z.string().max(100)).max(50).optional(),
});

// Generate character sheet for a node
router.post(
  '/nodes/:id/character-sheet',
  requireAuth,
  requireEmailVerified('Email verification required to generate images'),
  async (req, res, next) => {
    try {
      const validatedData = generateCharacterSheetSchema.parse(req.body);
      const result = await characterSheetService.generate({
        nodeId: req.params.id,
        userId: req.user?.id,
        settings: validatedData.settings,
        aspectRatio: validatedData.aspectRatio,
        stylePreset: validatedData.stylePreset,
        stylePrompt: validatedData.stylePrompt,
      });

      res.status(201).json({
        id: result.id,
        status: result.status,
        prompt: result.prompt,
        createdAt: result.createdAt,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: { message: 'Invalid request', code: 'VALIDATION_ERROR', details: error.issues },
        });
        return;
      }
      if (error instanceof Error && error.message === 'Node not found') {
        res.status(404).json({ error: { message: 'Node not found', code: 'NOT_FOUND' } });
        return;
      }
      next(error);
    }
  }
);

// Set primary media for a node
router.patch('/nodes/:id/primary-media', requireAuth, async (req, res, next) => {
  try {
    const validatedData = setPrimaryMediaSchema.parse(req.body);
    await characterSheetService.setPrimaryMedia(req.params.id, validatedData.mediaId, req.user?.id);

    res.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: { message: 'Invalid request', code: 'VALIDATION_ERROR', details: error.issues },
      });
      return;
    }
    if (error instanceof Error && error.message === 'Node not found') {
      res.status(404).json({ error: { message: 'Node not found', code: 'NOT_FOUND' } });
      return;
    }
    if (error instanceof Error && error.message.includes('not associated')) {
      res.status(400).json({ error: { message: error.message, code: 'INVALID_ASSOCIATION' } });
      return;
    }
    next(error);
  }
});

// Get node with associated media
router.get('/nodes/:id', requireAuth, async (req, res, next) => {
  try {
    const result = await characterSheetService.getNodeMedia(req.params.id, req.user?.id);
    res.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'Node not found') {
      res.status(404).json({ error: { message: 'Node not found', code: 'NOT_FOUND' } });
      return;
    }
    next(error);
  }
});

// SSE stream for node media updates
router.get('/nodes/:id/stream', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    // Verify node exists and user has access
    await characterSheetService.getNodeMedia(id, req.user?.id);

    const clientId = randomUUID();
    sseService.addClient(clientId, `node:${id}`, res);
  } catch (error) {
    if (error instanceof Error && error.message === 'Node not found') {
      res.status(404).json({ error: { message: 'Node not found', code: 'NOT_FOUND' } });
      return;
    }
    next(error);
  }
});

// Update node style
router.patch('/nodes/:id/style', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const validatedData = updateNodeStyleSchema.parse(req.body);

    // Verify ownership and update in FalkorDB
    const updated = await graphService.updateStoryNodeStyle(
      id,
      validatedData.stylePreset,
      validatedData.stylePrompt
    );

    if (!updated || updated.userId !== req.user?.id) {
      res.status(404).json({ error: { message: 'Node not found', code: 'NOT_FOUND' } });
      return;
    }

    res.json({
      id: updated.id,
      stylePreset: updated.stylePreset,
      stylePrompt: updated.stylePrompt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: { message: 'Invalid request', code: 'VALIDATION_ERROR', details: error.issues },
      });
      return;
    }
    next(error);
  }
});

// Update node properties (name, description, aliases)
router.patch('/nodes/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const validatedData = updateNodeSchema.parse(req.body);

    // Verify ownership first
    const existing = await graphService.getStoryNodeById(id, req.user?.id);
    if (!existing) {
      res.status(404).json({ error: { message: 'Node not found', code: 'NOT_FOUND' } });
      return;
    }

    // Update in FalkorDB
    await graphService.updateStoryNode(id, validatedData);

    // Get updated node
    const updated = await graphService.getStoryNodeById(id, req.user?.id);

    res.json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: { message: 'Invalid request', code: 'VALIDATION_ERROR', details: error.issues },
      });
      return;
    }
    next(error);
  }
});

// Chapter detection helpers
interface Chapter {
  id: string;
  title: string;
  startPosition: number;
}

function detectChaptersFromContent(contentJson: any): Chapter[] {
  // Parse ProseMirror document for H1 blocks
  const chapters: Chapter[] = [];
  let position = 0;

  if (!contentJson?.content) return chapters;

  for (const node of contentJson.content) {
    if (node.type === 'heading' && node.attrs?.level === 1) {
      const title = node.content?.[0]?.text || 'Untitled Chapter';
      chapters.push({
        id: `chapter-${chapters.length + 1}`,
        title,
        startPosition: position,
      });
    }

    // Update position (approximate character count)
    if (node.content) {
      position += JSON.stringify(node.content).length;
    }
  }

  return chapters;
}

function findChapterForPosition(chapters: Chapter[], position: number): Chapter | null {
  if (chapters.length === 0) return null;

  for (let i = chapters.length - 1; i >= 0; i--) {
    if (position >= chapters[i].startPosition) {
      return chapters[i];
    }
  }

  return chapters[0]; // Before first chapter
}

// Get a single mention by ID
router.get('/mentions/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const mention = await mentionService.getMentionById(id);

    if (!mention) {
      res.status(404).json({ error: { message: 'Mention not found', code: 'NOT_FOUND' } });
      return;
    }

    res.json({ mention });
  } catch (err) {
    next(err);
  }
});

// Get mentions for a node with absolute positions
router.get('/nodes/:id/mentions', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { documentId } = req.query;

    if (!documentId || typeof documentId !== 'string') {
      res.status(400).json({
        error: { message: 'documentId query parameter required', code: 'VALIDATION_ERROR' },
      });
      return;
    }

    // Get segments for the document
    const segments = await segmentService.getDocumentSegments(documentId);

    // Get all event nodes for this document to find context for each mention
    const allNodes = await graphService.getStoryNodesForDocument(documentId, req.user?.id);
    const eventNodes = allNodes.filter((n) => n.type === 'event');

    // Build map of event positions with their names and thread info
    const eventContextMap = new Map<
      string,
      {
        eventName: string;
        threadName: string | null;
        threadColor: string | null;
        positions: Array<{ start: number; end: number }>;
      }
    >();

    const { graphThreads } = await import('../services/graph/graph.threads');
    for (const event of eventNodes) {
      const eventMentions = await mentionService.getByNodeIdWithAbsolutePositions(
        event.id,
        segments
      );

      // Get thread info for this event
      const threads = await graphThreads.getThreadsForEvent(event.id);
      let threadName: string | null = null;
      let threadColor: string | null = null;
      if (threads.length > 0) {
        const thread = await graphThreads.getThreadById(threads[0].threadId);
        if (thread) {
          threadName = thread.name;
          threadColor = thread.color;
        }
      }

      eventContextMap.set(event.id, {
        eventName: event.name,
        threadName,
        threadColor,
        positions: eventMentions.map((m) => ({ start: m.absoluteStart, end: m.absoluteEnd })),
      });
    }

    // Get document for chapter detection
    const [document] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);

    const chapters = document?.contentJson ? detectChaptersFromContent(document.contentJson) : [];

    // Get mentions for the target node
    const mentions = await mentionService.getByNodeIdWithAbsolutePositions(id, segments);

    // For each mention, find ALL matching events + chapter context
    const mentionsWithContext = mentions.map((m) => {
      const matchingEvents: Array<{
        eventName: string;
        threadName: string | null;
        threadColor: string | null;
      }> = [];

      // Collect ALL matching events (no break)
      for (const eventData of eventContextMap.values()) {
        for (const eventPos of eventData.positions) {
          // Check if mention overlaps with event range
          const overlaps = !(m.absoluteEnd < eventPos.start || m.absoluteStart > eventPos.end);

          if (overlaps) {
            matchingEvents.push({
              eventName: eventData.eventName,
              threadName: eventData.threadName,
              threadColor: eventData.threadColor,
            });
            break; // One match per event (don't duplicate if event has multiple positions)
          }
        }
      }

      // Find chapter
      const chapter = findChapterForPosition(chapters, m.absoluteStart);

      return {
        id: m.id,
        absoluteStart: m.absoluteStart,
        absoluteEnd: m.absoluteEnd,
        originalText: m.originalText,
        confidence: m.confidence,
        source: m.source,
        isKeyPassage: m.isKeyPassage,
        events: matchingEvents,
        chapterTitle: chapter?.title || null,
        chapterId: chapter?.id || null,
      };
    });

    res.json({
      nodeId: id,
      documentId,
      mentions: mentionsWithContext,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('not found')) {
      res.status(404).json({ error: { message: error.message, code: 'NOT_FOUND' } });
      return;
    }
    next(error);
  }
});

// Toggle isKeyPassage for a mention
router.patch('/mentions/:mentionId/key-passage', requireAuth, async (req, res, next) => {
  try {
    const { mentionId } = req.params;
    const { isKeyPassage } = z.object({ isKeyPassage: z.boolean() }).parse(req.body);

    // Update the mention
    await mentionService.updateKeyPassage(mentionId, isKeyPassage);

    res.json({ success: true, isKeyPassage });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: { message: 'Invalid request', code: 'VALIDATION_ERROR', details: error.issues },
      });
      return;
    }
    next(error);
  }
});

// Get all mentions for a document with absolute positions
router.get('/documents/:id/mentions', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;

    const mentions = await mentionService.getByDocumentIdWithAbsolutePositions(id);

    res.json({ mentions });
  } catch (error) {
    next(error);
  }
});

export default router;
