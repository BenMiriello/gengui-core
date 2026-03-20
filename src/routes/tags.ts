import { Router } from 'express';
import { devAuth } from '../middleware/devAuth';
import { tagService } from '../services/tagService';
import { parseStringParam } from '../utils/validation';

const router = Router();

router.post('/tags', devAuth, async (req, res, next) => {
  try {
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
      res.status(400).json({
        error: { message: 'Name is required', code: 'INVALID_INPUT' },
      });
      return;
    }

    const tag = await tagService.create(req.user?.id as string, name);

    res.status(201).json(tag);
  } catch (error) {
    next(error);
  }
});

router.get('/tags', devAuth, async (req, res, next) => {
  try {
    const tags = await tagService.list(req.user?.id as string);

    res.json({ tags, count: tags.length });
  } catch (error) {
    next(error);
  }
});

router.post('/media/:id/tags', devAuth, async (req, res, next) => {
  try {
    const id = parseStringParam(req.params.id, 'id');
    const { tagId } = req.body;

    if (!tagId || typeof tagId !== 'string') {
      res.status(400).json({
        error: { message: 'tagId is required', code: 'INVALID_INPUT' },
      });
      return;
    }

    const result = await tagService.addToMedia(
      id,
      tagId,
      req.user?.id as string,
    );

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

router.delete('/media/:id/tags/:tagId', devAuth, async (req, res, next) => {
  try {
    const id = parseStringParam(req.params.id, 'id');
    const tagId = parseStringParam(req.params.tagId, 'tagId');
    const result = await tagService.removeFromMedia(
      id,
      tagId,
      req.user?.id as string,
    );

    res.json({ message: 'Tag removed from media', ...result });
  } catch (error) {
    next(error);
  }
});

export default router;
