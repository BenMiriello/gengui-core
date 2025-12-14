import { Router } from 'express';
import { generationsService } from '../services/generationsService';
import { devAuth } from '../middleware/devAuth';
import { z } from 'zod';

const router = Router();

const createGenerationSchema = z.object({
  prompt: z.string().min(1).max(1000),
  seed: z.number().int().min(0).optional(),
  width: z.number().int().min(256).max(2048).optional(),
  height: z.number().int().min(256).max(2048).optional(),
});

router.post('/', devAuth, async (req, res, next) => {
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

router.get('/', devAuth, async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const results = await generationsService.list(req.user!.id, limit);

    res.json({ generations: results, count: results.length });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', devAuth, async (req, res, next) => {
  try {
    const generation = await generationsService.getById(req.params.id, req.user!.id);

    res.json(generation);
  } catch (error) {
    next(error);
  }
});

export default router;
