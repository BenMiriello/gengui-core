import { Router } from 'express';
import { randomUUID } from 'crypto';
import { requireAuth, requireEmailVerified } from '../middleware/auth';
import { characterSheetService } from '../services/characterSheetService';
import { sseService } from '../services/sse';
import { z } from 'zod';
import { db } from '../config/database';
import { storyNodes } from '../models/schema';
import { eq, and, isNull } from 'drizzle-orm';

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
        userId: req.user!.id,
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
    await characterSheetService.setPrimaryMedia(
      req.params.id,
      validatedData.mediaId,
      req.user!.id
    );

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
    const result = await characterSheetService.getNodeMedia(req.params.id, req.user!.id);
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
    await characterSheetService.getNodeMedia(id, req.user!.id);

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

    // Verify ownership and update
    const [updated] = await db
      .update(storyNodes)
      .set({
        stylePreset: validatedData.stylePreset,
        stylePrompt: validatedData.stylePrompt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(storyNodes.id, id),
          eq(storyNodes.userId, req.user!.id),
          isNull(storyNodes.deletedAt)
        )
      )
      .returning();

    if (!updated) {
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

export default router;
