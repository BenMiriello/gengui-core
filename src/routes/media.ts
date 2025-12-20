import { Router } from 'express';
import multer from 'multer';
import { mediaService } from '../services/mediaService';
import { requireAuth } from '../middleware/auth';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.post('/', requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: { message: 'No file provided', code: 'NO_FILE' } });
      return;
    }

    const result = await mediaService.upload(req.user!.id, req.file);

    res.status(201).json({
      id: result.id,
      storageKey: result.storageKey,
      url: result.url,
      size: req.file.size,
      mimeType: req.file.mimetype,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const cursor = req.query.cursor as string | undefined;

    const results = await mediaService.list(req.user!.id, limit, cursor);

    res.json({ media: results, count: results.length });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const mediaItem = await mediaService.getById(req.params.id, req.user!.id);

    res.json(mediaItem);
  } catch (error) {
    next(error);
  }
});

router.get('/:id/url', requireAuth, async (req, res, next) => {
  try {
    const expiresIn = parseInt(req.query.expiresIn as string) || 900;
    const url = await mediaService.getSignedUrl(req.params.id, req.user!.id, expiresIn);

    res.json({ url, expiresIn });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/documents', requireAuth, async (req, res, next) => {
  try {
    const userId = (req as any).user.id;
    const { id } = req.params;
    const documents = await mediaService.getDocumentsByMediaId(id, userId);
    res.json({ documents });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const result = await mediaService.delete(req.params.id, req.user!.id);

    res.json({ message: 'Media deleted', id: result.id });
  } catch (error) {
    next(error);
  }
});

export default router;
