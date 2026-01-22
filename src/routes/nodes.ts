import { Router } from 'express';
import { requireAuth, requireEmailVerified } from '../middleware/auth';
import { characterSheetService } from '../services/characterSheetService';
import { z } from 'zod';

const router = Router();

const characterSheetSettingsSchema = z.object({
  framing: z.enum(['portrait', 'full_body']).optional(),
  perspective: z.enum(['exterior', 'interior', 'custom']).optional(),
  perspectiveCustom: z.string().max(200).optional(),
  background: z.enum(['white', 'black', 'transparent', 'custom']),
  backgroundCustom: z.string().max(200).optional(),
  manualEdit: z.boolean(),
  customDescription: z.string().max(2000).optional(),
});

const generateCharacterSheetSchema = z.object({
  settings: characterSheetSettingsSchema,
  width: z.number().int().min(512).max(2048).optional(),
  height: z.number().int().min(512).max(2048).optional(),
});

const setPrimaryMediaSchema = z.object({
  mediaId: z.string().uuid(),
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
        width: validatedData.width,
        height: validatedData.height,
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

export default router;
