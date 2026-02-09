import { logger } from '../../utils/logger';
import { graphService } from './graph.service';
import type { CausalOrderResult, ThreadDetectionResult } from './graph.types';
import { causalEdgePattern } from './graph.types';

interface CausalEdge {
  fromId: string;
  toId: string;
}

/**
 * Compute causal ordering via topological sort (Kahn's algorithm).
 * Uses documentOrder as tiebreaker for nodes at the same level.
 */
export async function computeCausalOrder(
  documentId: string,
  userId: string
): Promise<CausalOrderResult[]> {
  const [edgeResult, nodeResult] = await Promise.all([
    graphService.query(
      `
      MATCH (a:StoryNode)-[r${causalEdgePattern()}]->(b:StoryNode)
      WHERE a.documentId = $documentId AND a.deletedAt IS NULL
        AND b.deletedAt IS NULL AND r.deletedAt IS NULL
      RETURN a.id, b.id
      `,
      { documentId }
    ),
    graphService.query(
      `
      MATCH (n:StoryNode)
      WHERE n.documentId = $documentId AND n.userId = $userId AND n.deletedAt IS NULL
      RETURN n.id, n.documentOrder
      `,
      { documentId, userId }
    ),
  ]);

  const edges: CausalEdge[] = edgeResult.data.map((row) => ({
    fromId: row[0] as string,
    toId: row[1] as string,
  }));

  const documentOrders = new Map<string, number>();
  const allNodeIds = new Set<string>();
  for (const row of nodeResult.data) {
    const id = row[0] as string;
    allNodeIds.add(id);
    const docOrder = row[1] as number | null;
    if (docOrder !== null) documentOrders.set(id, docOrder);
  }

  // Build adjacency list and in-degree map
  const adjList = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const id of allNodeIds) {
    adjList.set(id, []);
    inDegree.set(id, 0);
  }

  for (const edge of edges) {
    if (!allNodeIds.has(edge.fromId) || !allNodeIds.has(edge.toId)) continue;
    adjList.get(edge.fromId)?.push(edge.toId);
    inDegree.set(edge.toId, (inDegree.get(edge.toId) ?? 0) + 1);
  }

  // Kahn's algorithm with documentOrder tiebreaking
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  // Sort initial queue by documentOrder (lower first)
  queue.sort((a, b) => (documentOrders.get(a) ?? Infinity) - (documentOrders.get(b) ?? Infinity));

  const results: CausalOrderResult[] = [];
  let position = 0;

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    results.push({ nodeId, position });
    position++;

    const neighbors = adjList.get(nodeId) ?? [];
    const newZeroDegree: string[] = [];

    for (const neighbor of neighbors) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) newZeroDegree.push(neighbor);
    }

    // Sort newly available nodes by documentOrder
    newZeroDegree.sort(
      (a, b) => (documentOrders.get(a) ?? Infinity) - (documentOrders.get(b) ?? Infinity)
    );

    // Insert into queue maintaining sort order
    for (const n of newZeroDegree) {
      const insertIdx = queue.findIndex(
        (q) => (documentOrders.get(q) ?? Infinity) > (documentOrders.get(n) ?? Infinity)
      );
      if (insertIdx === -1) queue.push(n);
      else queue.splice(insertIdx, 0, n);
    }
  }

  if (results.length < allNodeIds.size) {
    const sorted = new Set(results.map((r) => r.nodeId));
    const cycleNodes = [...allNodeIds].filter((id) => !sorted.has(id));
    logger.warn(
      { documentId, cycleNodeCount: cycleNodes.length },
      'Cycle detected in causal graph -- some nodes excluded from ordering'
    );
  }

  return results;
}

/**
 * Detect narrative threads via weakly connected components on the causal subgraph.
 */
export async function detectThreads(
  documentId: string,
  userId: string
): Promise<ThreadDetectionResult[]> {
  const [edgeResult, nodeResult] = await Promise.all([
    graphService.query(
      `
      MATCH (a:StoryNode)-[r${causalEdgePattern()}]->(b:StoryNode)
      WHERE a.documentId = $documentId AND a.deletedAt IS NULL
        AND b.deletedAt IS NULL AND r.deletedAt IS NULL
      RETURN a.id, b.id
      `,
      { documentId }
    ),
    graphService.query(
      `
      MATCH (n:StoryNode)
      WHERE n.documentId = $documentId AND n.userId = $userId AND n.deletedAt IS NULL
      RETURN n.id
      `,
      { documentId, userId }
    ),
  ]);

  const allNodeIds = new Set<string>(nodeResult.data.map((row) => row[0] as string));

  // Build undirected adjacency list
  const adj = new Map<string, Set<string>>();
  for (const id of allNodeIds) adj.set(id, new Set());

  for (const row of edgeResult.data) {
    const from = row[0] as string;
    const to = row[1] as string;
    if (!allNodeIds.has(from) || !allNodeIds.has(to)) continue;
    adj.get(from)?.add(to);
    adj.get(to)?.add(from);
  }

  // BFS to find weakly connected components
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const startId of allNodeIds) {
    if (visited.has(startId)) continue;

    const component: string[] = [];
    const queue = [startId];
    visited.add(startId);

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      component.push(nodeId);

      for (const neighbor of adj.get(nodeId) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    components.push(component);
  }

  // Separate multi-node threads from single-node isolates
  const multiNodeThreads = components.filter((c) => c.length > 1);
  const singleNodeIds = components.filter((c) => c.length === 1).flat();

  const results: ThreadDetectionResult[] = multiNodeThreads.map((memberNodeIds) => ({
    memberNodeIds,
  }));

  // Merge all single-node isolates into one "Uncategorized" thread
  if (singleNodeIds.length > 0) {
    results.push({
      memberNodeIds: singleNodeIds,
      suggestedName: 'Uncategorized',
    });
  }

  return results;
}

/**
 * Find all downstream nodes reachable from a given node via causal edges.
 */
export async function getDownstreamNodes(nodeId: string, documentId: string): Promise<string[]> {
  const result = await graphService.query(
    `
    MATCH (start:StoryNode)-[:CAUSES|ENABLES*1..50]->(downstream:StoryNode)
    WHERE start.id = $nodeId AND start.documentId = $documentId
      AND downstream.deletedAt IS NULL
    RETURN DISTINCT downstream.id
    `,
    { nodeId, documentId }
  );

  return result.data.map((row) => row[0] as string);
}

/**
 * Find articulation points (pivotal events) in the causal subgraph.
 * Uses a simplified approach: nodes whose removal increases the number of
 * weakly connected components.
 */
export async function findPivotalNodes(documentId: string, userId: string): Promise<string[]> {
  const [edgeResult, nodeResult] = await Promise.all([
    graphService.query(
      `
      MATCH (a:StoryNode)-[r${causalEdgePattern()}]->(b:StoryNode)
      WHERE a.documentId = $documentId AND a.deletedAt IS NULL
        AND b.deletedAt IS NULL AND r.deletedAt IS NULL
      RETURN a.id, b.id
      `,
      { documentId }
    ),
    graphService.query(
      `
      MATCH (n:StoryNode)
      WHERE n.documentId = $documentId AND n.userId = $userId AND n.deletedAt IS NULL
      RETURN n.id
      `,
      { documentId, userId }
    ),
  ]);

  const allNodeIds = new Set<string>(nodeResult.data.map((row) => row[0] as string));
  const edges = edgeResult.data.map((row) => ({
    from: row[0] as string,
    to: row[1] as string,
  }));

  // Count baseline components
  const baselineCount = countComponents(allNodeIds, edges);

  const pivotal: string[] = [];
  for (const removeId of allNodeIds) {
    const reducedNodes = new Set(allNodeIds);
    reducedNodes.delete(removeId);
    const reducedEdges = edges.filter((e) => e.from !== removeId && e.to !== removeId);
    const newCount = countComponents(reducedNodes, reducedEdges);
    if (newCount > baselineCount) pivotal.push(removeId);
  }

  return pivotal;
}

function countComponents(nodeIds: Set<string>, edges: { from: string; to: string }[]): number {
  const adj = new Map<string, Set<string>>();
  for (const id of nodeIds) adj.set(id, new Set());
  for (const { from, to } of edges) {
    if (!nodeIds.has(from) || !nodeIds.has(to)) continue;
    adj.get(from)?.add(to);
    adj.get(to)?.add(from);
  }

  const visited = new Set<string>();
  let count = 0;
  for (const id of nodeIds) {
    if (visited.has(id)) continue;
    count++;
    const queue = [id];
    visited.add(id);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const neighbor of adj.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
  }
  return count;
}

/**
 * Find structural gaps: events with no causal antecedent (except the first event).
 */
export async function findCausalGaps(documentId: string, userId: string): Promise<string[]> {
  const result = await graphService.query(
    `
    MATCH (e:StoryNode)
    WHERE e.documentId = $documentId AND e.userId = $userId
      AND e.deletedAt IS NULL AND e.type = $eventType
      AND e.documentOrder > $minOrder
    OPTIONAL MATCH (pred:StoryNode)-[r${causalEdgePattern()}]->(e)
    WHERE pred.deletedAt IS NULL AND r.deletedAt IS NULL
    WITH e, pred
    WHERE pred IS NULL
    RETURN e.id
    `,
    { documentId, userId, eventType: 'event', minOrder: 0 }
  );

  return result.data.map((row) => row[0] as string);
}
