import { Router } from 'express';
import multer from 'multer';
import { PRESIGNED_S3_URL_EXPIRATION } from '../config/constants';
import { requireAuth } from '../middleware/auth';
import { mediaService } from '../services/mediaService';
import { sseService } from '../services/sse';
import { parseStringParam } from '../utils/validation';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

router.post('/', requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      res
        .status(400)
        .json({ error: { message: 'No file provided', code: 'NO_FILE' } });
      return;
    }

    if (!req.user) throw new Error('User not authenticated');
    const result = await mediaService.upload(req.user.id, req.file);

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
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const excludeRolesParam = req.query.excludeRoles as string | undefined;
    const excludeRoles = excludeRolesParam
      ? excludeRolesParam.split(',')
      : undefined;

    if (!req.user) throw new Error('User not authenticated');
    const results = await mediaService.list(req.user.id, limit, {
      excludeRoles,
    });

    res.json({ media: results, count: results.length });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) throw new Error('User not authenticated');
    const id = parseStringParam(req.params.id, 'id');
    const mediaItem = await mediaService.getById(id, req.user.id);

    res.json(mediaItem);
  } catch (error) {
    next(error);
  }
});

router.get('/:id/url', requireAuth, async (req, res, next) => {
  try {
    const id = parseStringParam(req.params.id, 'id');
    const expiresIn =
      parseInt(req.query.expiresIn as string, 10) ||
      PRESIGNED_S3_URL_EXPIRATION;
    const type = (req.query.type as string) === 'thumb' ? 'thumb' : 'full';
    if (!req.user) throw new Error('User not authenticated');
    const url = await mediaService.getSignedUrl(
      id,
      req.user.id,
      expiresIn,
      type,
    );

    res.json({ url, expiresIn });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/documents', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) throw new Error('User not authenticated');
    const userId = req.user.id;
    const id = parseStringParam(req.params.id, 'id');

    const fields = req.query.fields
      ? (req.query.fields as string).split(',')
      : undefined;

    const documents = await mediaService.getDocumentsByMediaId(
      id,
      userId,
      fields,
    );
    res.json({ documents });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/node', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) throw new Error('User not authenticated');
    const userId = req.user.id;
    const id = parseStringParam(req.params.id, 'id');

    const node = await mediaService.getNodeByMediaId(id, userId);
    res.json({ node });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const mediaId = parseStringParam(req.params.id, 'id');
    const userId = req.user?.id as string;

    const documents = await mediaService.getDocumentsByMediaId(
      mediaId,
      userId,
      ['id'],
    );

    const result = await mediaService.delete(mediaId, userId);

    for (const doc of documents) {
      if (doc.id) {
        await sseService.broadcastToDocument(doc.id, 'media-deleted', {
          documentId: doc.id,
          mediaId,
          nodeId: undefined,
        });
      }
    }

    res.json({ message: 'Media deleted', id: result.id });
  } catch (error) {
    next(error);
  }
});

export default router;
