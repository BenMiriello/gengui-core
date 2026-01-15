import { Router } from 'express';
import { generationsService } from '../services/generationsService';
import { requireAuth, requireEmailVerified } from '../middleware/auth';
import { generationRateLimiter } from '../middleware/generationRateLimiter';
import { augmentationRateLimiter } from '../middleware/augmentationRateLimiter';
import { z } from 'zod';
import {
  MAX_PROMPT_LENGTH,
  MIN_WIDTH,
  MAX_WIDTH,
  MIN_HEIGHT,
  MAX_HEIGHT
} from '../config/constants';

const router = Router();

const promptEnhancementSchema = z.object({
  enabled: z.boolean(),
  charsBefore: z.number().int().min(0).max(2000),
  charsAfter: z.number().int().min(0).max(2000),
  useNarrativeContext: z.boolean(),
  sceneTreatment: z.enum(['comprehensive', 'focused', 'selective-detail']),
  selectiveDetailFocus: z.string().max(200).optional(),
  strength: z.enum(['low', 'medium', 'high']),
});

const createGenerationSchema = z.object({
  prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  seed: z.number().int().min(0).optional(),
  width: z.number().int().min(MIN_WIDTH).max(MAX_WIDTH).optional(),
  height: z.number().int().min(MIN_HEIGHT).max(MAX_HEIGHT).optional(),
  documentId: z.string().uuid().optional(),
  startChar: z.number().int().min(0).optional(),
  endChar: z.number().int().min(0).optional(),
  sourceText: z.string().optional(),
  nodePos: z.number().int().min(0).optional(),
  textOffset: z.number().int().min(0).optional(),
  contextBefore: z.string().optional(),
  contextAfter: z.string().optional(),
  promptEnhancement: promptEnhancementSchema.optional(),
});

router.post('/', requireAuth, requireEmailVerified('Email verification required to generate images'), augmentationRateLimiter, generationRateLimiter, async (req, res, next) => {
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

router.post('/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const result = await generationsService.cancel(req.params.id, req.user!.id);
    res.json(result);
  } catch (error) {
    // Job already completed - return 409 Conflict
    if (error instanceof Error && error.message.includes('already completed')) {
      res.status(409).json({ error: { message: error.message, code: 'ALREADY_COMPLETED' } });
      return;
    }
    // Job already failed - return 409 Conflict
    if (error instanceof Error && error.message.includes('already failed')) {
      res.status(409).json({ error: { message: error.message, code: 'ALREADY_FAILED' } });
      return;
    }
    next(error);
  }
});

export default router;
