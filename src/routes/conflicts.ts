import { and, desc, eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { Router } from 'express';
import { db } from '../config/database';
import { requireAuth } from '../middleware/auth';
import { reviewQueue } from '../models/schema';
import { parseStringParam } from '../utils/validation';

const router = Router();

router.get(
  '/nodes/:nodeId/conflicts',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const nodeId = parseStringParam(req.params.nodeId, 'nodeId');
      const { status = 'pending' } = req.query;

      const whereClause =
        status === 'all'
          ? eq(reviewQueue.primaryEntityId, nodeId)
          : and(
              eq(reviewQueue.primaryEntityId, nodeId),
              eq(reviewQueue.status, status as string),
            );

      const conflicts = await db
        .select()
        .from(reviewQueue)
        .where(whereClause)
        .orderBy(desc(reviewQueue.createdAt));

      const transformed = conflicts.map((c: Record<string, unknown>) => {
        const resolution = c.resolution as Record<string, unknown> | undefined;
        const metadata = resolution?.metadata as
          | Record<string, unknown>
          | undefined;
        const facets = resolution?.facets as
          | Record<string, unknown>
          | undefined;

        return {
          id: c.id,
          entityId: c.primaryEntityId,
          entityName: metadata?.entityName,
          facetType: metadata?.facetType,
          facetA: facets?.facetA,
          facetB: facets?.facetB,
          conflictType: c.conflictType,
          reasoning: c.contextSummary,
          isPlotHole: metadata?.isPlotHole || false,
          isWeakCausation: metadata?.isWeakCausation || false,
          stateIds: c.stateIds || [],
          status: c.status,
          createdAt: c.createdAt,
        };
      });

      res.json({ conflicts: transformed });
    } catch (error) {
      console.error('Failed to fetch conflicts:', error);
      res.status(500).json({ error: 'Failed to fetch conflicts' });
    }
  },
);

router.patch(
  '/conflicts/:conflictId/resolve',
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const conflictId = parseStringParam(req.params.conflictId, 'conflictId');
      const { resolution: userResolution, notes } = req.body;
      const userId = req.user?.id as string;

      const [existing] = await db
        .select()
        .from(reviewQueue)
        .where(eq(reviewQueue.id, conflictId))
        .limit(1);

      const [updated] = await db
        .update(reviewQueue)
        .set({
          status: 'resolved',
          resolvedAt: new Date(),
          resolvedBy: userId,
          resolution: {
            ...(existing?.resolution || {}),
            userAction: userResolution,
            notes,
          },
        })
        .where(eq(reviewQueue.id, conflictId))
        .returning();

      res.json({ conflict: updated });
    } catch (error) {
      console.error('Failed to resolve conflict:', error);
      res.status(500).json({ error: 'Failed to resolve conflict' });
    }
  },
);

export default router;
