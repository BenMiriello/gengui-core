import { Router, Request, Response, NextFunction } from 'express';
import { customStylePromptsService } from '../services/customStylePrompts';
import { requireAuth } from '../middleware/auth';
import {
  MAX_CUSTOM_STYLE_PROMPT_LENGTH,
  MAX_CUSTOM_STYLE_PROMPTS_PER_USER
} from '../config/constants';

const router = Router();

router.get('/custom-style-prompts', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const prompts = await customStylePromptsService.list(userId);
    res.json({ prompts });
  } catch (error) {
    next(error);
  }
});

router.post('/custom-style-prompts', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { name, prompt } = req.body;

    if (!name || !prompt) {
      res.status(400).json({
        error: { message: 'Name and prompt are required', code: 'INVALID_INPUT' }
      });
      return;
    }

    if (prompt.length > MAX_CUSTOM_STYLE_PROMPT_LENGTH) {
      res.status(400).json({
        error: { message: `Prompt must be ${MAX_CUSTOM_STYLE_PROMPT_LENGTH} characters or less`, code: 'INVALID_INPUT' }
      });
      return;
    }

    const existingPrompts = await customStylePromptsService.list(userId);
    if (existingPrompts.length >= MAX_CUSTOM_STYLE_PROMPTS_PER_USER) {
      res.status(400).json({
        error: { message: `Maximum ${MAX_CUSTOM_STYLE_PROMPTS_PER_USER} custom prompts allowed`, code: 'MAX_PROMPTS_REACHED' }
      });
      return;
    }

    const customPrompt = await customStylePromptsService.create(userId, name, prompt);
    res.status(201).json({ prompt: customPrompt });
  } catch (error) {
    next(error);
  }
});

router.patch('/custom-style-prompts/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;
    const { name, prompt } = req.body;

    if (prompt && prompt.length > MAX_CUSTOM_STYLE_PROMPT_LENGTH) {
      res.status(400).json({
        error: { message: `Prompt must be ${MAX_CUSTOM_STYLE_PROMPT_LENGTH} characters or less`, code: 'INVALID_INPUT' }
      });
      return;
    }

    const updated = await customStylePromptsService.update(id, userId, name, prompt);
    res.json({ prompt: updated });
  } catch (error) {
    next(error);
  }
});

router.delete('/custom-style-prompts/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;

    await customStylePromptsService.softDelete(id, userId);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
