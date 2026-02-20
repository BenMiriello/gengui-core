/**
 * Within-Segment Batch Clustering
 *
 * Clusters entity mentions within a segment before graph resolution.
 * This prevents duplicate creation for the same character mentioned
 * multiple ways (e.g., "Harry Potter", "Harry", "Potter", "The Boy Who Lived").
 */

import type {
  EntityCandidate,
  EntityCluster,
  ResolutionThresholds,
} from './types';
import { DEFAULT_THRESHOLDS } from './types';
import type { FacetInput } from '../../types/storyNodes';
import { cosineSimilarity, scoreNameSimilarity } from './scoring';

/**
 * Compute similarity between two entity candidates.
 * Uses embedding similarity and name similarity.
 */
function computeCandidateSimilarity(a: EntityCandidate, b: EntityCandidate): number {
  // Type must match for clustering
  if (a.type !== b.type) return 0;

  // Embedding similarity (primary signal)
  const embeddingSim = cosineSimilarity(a.embedding, b.embedding);

  // Name similarity (secondary signal)
  const nameSim = scoreNameSimilarity(a.name, b.name);

  // Weighted combination (within-segment, name is more important)
  return embeddingSim * 0.4 + nameSim * 0.6;
}

/**
 * Compute average similarity of an entity to a cluster.
 */
function computeClusterSimilarity(
  candidate: EntityCandidate,
  cluster: EntityCluster
): number {
  if (cluster.members.length === 0) return 0;

  const scores = cluster.members.map((m) => computeCandidateSimilarity(candidate, m));
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/**
 * Select the primary name for a cluster.
 * Prefers the longest, most specific name.
 */
function selectPrimaryName(members: EntityCandidate[]): string {
  return members.reduce((longest, m) =>
    m.name.length > longest.name.length ? m : longest
  ).name;
}

/**
 * Compute average embedding for cluster members.
 */
function averageEmbeddings(members: EntityCandidate[]): number[] {
  if (members.length === 0) return [];

  const dim = members[0].embedding.length;
  const avg = new Array(dim).fill(0);

  for (const member of members) {
    for (let i = 0; i < dim; i++) {
      avg[i] += member.embedding[i];
    }
  }

  return avg.map((v) => v / members.length);
}

/**
 * Merge facets from multiple members, deduplicating by content.
 */
function mergeFacets(members: EntityCandidate[]): FacetInput[] {
  const seen = new Map<string, FacetInput>();

  for (const member of members) {
    for (const facet of member.facets) {
      const key = `${facet.type}:${facet.content}`;
      if (!seen.has(key)) {
        seen.set(key, facet);
      }
    }
  }

  return Array.from(seen.values());
}

/**
 * Cluster entities within a segment using agglomerative clustering.
 *
 * Algorithm:
 * 1. Start with each entity as its own cluster
 * 2. For each entity, try to merge with existing clusters
 * 3. Merge if average similarity > threshold
 *
 * Returns clusters ready for graph resolution.
 */
export function clusterWithinSegment(
  entities: EntityCandidate[],
  thresholds: ResolutionThresholds = DEFAULT_THRESHOLDS
): EntityCluster[] {
  if (entities.length === 0) return [];

  const clusters: EntityCluster[] = [];

  for (const entity of entities) {
    let merged = false;

    // Try to merge with existing cluster
    for (const cluster of clusters) {
      // Must be same type
      if (cluster.type !== entity.type) continue;

      const avgScore = computeClusterSimilarity(entity, cluster);

      if (avgScore > thresholds.withinSegment) {
        // Merge into existing cluster
        cluster.members.push(entity);
        cluster.aliases.push(entity.name);
        cluster.mentions.push(...entity.mentions);
        if (entity.segmentId && !cluster.segmentIds.includes(entity.segmentId)) {
          cluster.segmentIds.push(entity.segmentId);
        }
        merged = true;
        break;
      }
    }

    if (!merged) {
      // Create new cluster
      clusters.push({
        primaryName: entity.name,
        type: entity.type,
        aliases: [entity.name],
        members: [entity],
        mergedEmbedding: entity.embedding,
        mergedFacets: [...entity.facets],
        mentions: [...entity.mentions],
        segmentIds: entity.segmentId ? [entity.segmentId] : [],
      });
    }
  }

  // Finalize clusters
  return clusters.map((cluster) => ({
    ...cluster,
    primaryName: selectPrimaryName(cluster.members),
    aliases: [...new Set(cluster.aliases)],
    mergedEmbedding: averageEmbeddings(cluster.members),
    mergedFacets: mergeFacets(cluster.members),
  }));
}

/**
 * Group entities by segment and cluster within each segment.
 */
export function clusterBySegment(
  entities: EntityCandidate[],
  thresholds: ResolutionThresholds = DEFAULT_THRESHOLDS
): Map<string, EntityCluster[]> {
  // Group by segment
  const bySegment = new Map<string, EntityCandidate[]>();

  for (const entity of entities) {
    const existing = bySegment.get(entity.segmentId) || [];
    existing.push(entity);
    bySegment.set(entity.segmentId, existing);
  }

  // Cluster within each segment
  const result = new Map<string, EntityCluster[]>();

  for (const [segmentId, segmentEntities] of bySegment) {
    const clusters = clusterWithinSegment(segmentEntities, thresholds);
    result.set(segmentId, clusters);
  }

  return result;
}

/**
 * Cluster entities across all segments.
 * First clusters within segments, then merges clusters across segments.
 */
export function clusterAcrossSegments(
  entities: EntityCandidate[],
  thresholds: ResolutionThresholds = DEFAULT_THRESHOLDS
): EntityCluster[] {
  // First, cluster within each segment
  const bySegment = clusterBySegment(entities, thresholds);

  // Flatten all clusters
  const allClusters: EntityCluster[] = [];
  for (const clusters of bySegment.values()) {
    allClusters.push(...clusters);
  }

  if (allClusters.length <= 1) return allClusters;

  // Try to merge clusters across segments (higher threshold)
  const mergedClusters: EntityCluster[] = [];
  const crossSegmentThreshold = thresholds.withinSegment + 0.1; // Stricter for cross-segment

  for (const cluster of allClusters) {
    let merged = false;

    for (const existing of mergedClusters) {
      if (existing.type !== cluster.type) continue;

      // Check similarity between clusters using representative members
      const sim = cosineSimilarity(cluster.mergedEmbedding, existing.mergedEmbedding);
      const nameSim = scoreNameSimilarity(cluster.primaryName, existing.primaryName, existing.aliases);
      const combinedSim = sim * 0.4 + nameSim * 0.6;

      if (combinedSim > crossSegmentThreshold) {
        // Merge clusters
        existing.members.push(...cluster.members);
        existing.aliases.push(...cluster.aliases);
        existing.mentions.push(...cluster.mentions);
        existing.segmentIds.push(
          ...cluster.segmentIds.filter((s) => !existing.segmentIds.includes(s))
        );
        merged = true;
        break;
      }
    }

    if (!merged) {
      mergedClusters.push({ ...cluster });
    }
  }

  // Finalize merged clusters
  return mergedClusters.map((cluster) => ({
    ...cluster,
    primaryName: selectPrimaryName(cluster.members),
    aliases: [...new Set(cluster.aliases)],
    mergedEmbedding: averageEmbeddings(cluster.members),
    mergedFacets: mergeFacets(cluster.members),
  }));
}

/**
 * Convert a cluster back to an EntityCandidate for graph resolution.
 * Uses the merged properties of the cluster.
 */
export function clusterToCandidate(cluster: EntityCluster): EntityCandidate {
  return {
    name: cluster.primaryName,
    type: cluster.type,
    embedding: cluster.mergedEmbedding,
    facets: cluster.mergedFacets,
    mentions: cluster.mentions,
    segmentId: cluster.segmentIds[0] || '',
    documentOrder: cluster.members[0]?.documentOrder,
  };
}
