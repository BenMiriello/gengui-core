import type { Request, Response } from 'express';
import { Router } from 'express';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../config/database';
import { reviewQueue } from '../models/schema';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.get('/nodes/:nodeId/conflicts', requireAuth, async (req: Request, res: Response) => {
  try {
    const { nodeId } = req.params;
    const { status = 'pending' } = req.query;

    const whereClause = status === 'all'
      ? eq(reviewQueue.primaryEntityId, nodeId)
      : and(
          eq(reviewQueue.primaryEntityId, nodeId),
          eq(reviewQueue.status, status as string)
        );

    const conflicts = await db
      .select()
      .from(reviewQueue)
      .where(whereClause)
      .orderBy(desc(reviewQueue.createdAt));

    const transformed = conflicts.map((c: any) => ({
      id: c.id,
      entityId: c.primaryEntityId,
      entityName: (c.resolution as any)?.metadata?.entityName,
      facetType: (c.resolution as any)?.metadata?.facetType,
      facetA: (c.resolution as any)?.facets?.facetA,
      facetB: (c.resolution as any)?.facets?.facetB,
      conflictType: c.conflictType,
      reasoning: c.contextSummary,
      isPlotHole: (c.resolution as any)?.metadata?.isPlotHole || false,
      isWeakCausation: (c.resolution as any)?.metadata?.isWeakCausation || false,
      stateIds: c.stateIds || [],
      status: c.status,
      createdAt: c.createdAt,
    }));

    res.json({ conflicts: transformed });
  } catch (error) {
    console.error('Failed to fetch conflicts:', error);
    res.status(500).json({ error: 'Failed to fetch conflicts' });
  }
});

router.patch('/conflicts/:conflictId/resolve', requireAuth, async (req: Request, res: Response) => {
  try {
    const { conflictId } = req.params;
    const { resolution: userResolution, notes } = req.body;
    const userId = (req as any).user.id;

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
});

export default router;
