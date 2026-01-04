import { Router } from 'express';
import { generationsService } from '../services/generationsService';
import { requireAuth } from '../middleware/auth';
import { z } from 'zod';
import {
  MAX_PROMPT_LENGTH,
  MIN_WIDTH,
  MAX_WIDTH,
  MIN_HEIGHT,
  MAX_HEIGHT
} from '../config/constants';

const router = Router();

const createGenerationSchema = z.object({
  prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  seed: z.number().int().min(0).optional(),
  width: z.number().int().min(MIN_WIDTH).max(MAX_WIDTH).optional(),
  height: z.number().int().min(MIN_HEIGHT).max(MAX_HEIGHT).optional(),
  documentId: z.string().uuid().optional(),
  versionId: z.string().uuid().optional(),
  startChar: z.number().int().min(0).optional(),
  endChar: z.number().int().min(0).optional(),
  sourceText: z.string().optional(),
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const validatedData = createGenerationSchema.parse(req.body);
    const result = await generationsService.create(req.user!.id, validatedData);

    res.status(201).json({
      id: result.id,
      status: result.status,
      prompt: result.prompt,
      seed: result.seed,
      width: result.width,
      height: result.height,
      createdAt: result.createdAt,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: { message: 'Invalid request', code: 'VALIDATION_ERROR', details: error.issues } });
      return;
    }
    next(error);
  }
});

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const results = await generationsService.list(req.user!.id, limit);

    res.json({ generations: results, count: results.length });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const generation = await generationsService.getById(req.params.id, req.user!.id);

    res.json(generation);
  } catch (error) {
    next(error);
  }
});

export default router;
