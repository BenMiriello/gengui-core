/**
 * Multi-Index Blocking for Entity Resolution
 *
 * Reduces O(n²) comparisons to O(n*k) by using blocking indices.
 * Only entities sharing a blocking key are compared.
 *
 * Blocking indices:
 * 1. Name token index: "harry" → [entity_ids...]
 * 2. Phonetic code index: "HR" → [entity_ids...]
 * 3. Type filter: only compare same entity types
 */

import type { ExistingEntity, EntityCluster } from './types';
import { getNameTokens, getPhoneticCodes } from './aliasPatterns';

export interface BlockingIndex {
  byNameToken: Map<string, Set<string>>;
  byPhoneticCode: Map<string, Set<string>>;
  byType: Map<string, Set<string>>;
}

/**
 * Build blocking indices from existing entities.
 */
export function buildBlockingIndex(entities: ExistingEntity[]): BlockingIndex {
  const index: BlockingIndex = {
    byNameToken: new Map(),
    byPhoneticCode: new Map(),
    byType: new Map(),
  };

  for (const entity of entities) {
    // Index by name tokens
    const nameTokens = getNameTokens(entity.name);
    for (const token of nameTokens) {
      const key = token.toLowerCase();
      if (!index.byNameToken.has(key)) {
        index.byNameToken.set(key, new Set());
      }
      index.byNameToken.get(key)!.add(entity.id);
    }

    // Index by aliases
    if (entity.aliases) {
      for (const alias of entity.aliases) {
        const aliasTokens = getNameTokens(alias);
        for (const token of aliasTokens) {
          const key = token.toLowerCase();
          if (!index.byNameToken.has(key)) {
            index.byNameToken.set(key, new Set());
          }
          index.byNameToken.get(key)!.add(entity.id);
        }
      }
    }

    // Index by phonetic codes
    const phoneticCodes = getPhoneticCodes(entity.name);
    for (const code of phoneticCodes) {
      if (!index.byPhoneticCode.has(code)) {
        index.byPhoneticCode.set(code, new Set());
      }
      index.byPhoneticCode.get(code)!.add(entity.id);
    }

    // Index by type
    if (!index.byType.has(entity.type)) {
      index.byType.set(entity.type, new Set());
    }
    index.byType.get(entity.type)!.add(entity.id);
  }

  return index;
}

/**
 * Get candidate entity IDs for a cluster using blocking indices.
 * Returns IDs of entities that share at least one blocking key.
 */
export function getCandidateIds(
  cluster: EntityCluster,
  index: BlockingIndex
): Set<string> {
  const candidates = new Set<string>();

  // Must be same type
  const typeMatches = index.byType.get(cluster.type);
  if (!typeMatches || typeMatches.size === 0) {
    return candidates;
  }

  // Find candidates by name tokens
  const nameTokens = getNameTokens(cluster.primaryName);
  for (const token of nameTokens) {
    const key = token.toLowerCase();
    const matches = index.byNameToken.get(key);
    if (matches) {
      for (const id of matches) {
        if (typeMatches.has(id)) {
          candidates.add(id);
        }
      }
    }
  }

  // Also check aliases
  for (const alias of cluster.aliases) {
    const aliasTokens = getNameTokens(alias);
    for (const token of aliasTokens) {
      const key = token.toLowerCase();
      const matches = index.byNameToken.get(key);
      if (matches) {
        for (const id of matches) {
          if (typeMatches.has(id)) {
            candidates.add(id);
          }
        }
      }
    }
  }

  // Find candidates by phonetic codes
  const phoneticCodes = getPhoneticCodes(cluster.primaryName);
  for (const code of phoneticCodes) {
    const matches = index.byPhoneticCode.get(code);
    if (matches) {
      for (const id of matches) {
        if (typeMatches.has(id)) {
          candidates.add(id);
        }
      }
    }
  }

  return candidates;
}

/**
 * Filter existing entities to only those matching blocking keys.
 */
export function filterByBlocking(
  cluster: EntityCluster,
  existingEntities: ExistingEntity[],
  index: BlockingIndex
): ExistingEntity[] {
  const candidateIds = getCandidateIds(cluster, index);

  if (candidateIds.size === 0) {
    return [];
  }

  return existingEntities.filter((e) => candidateIds.has(e.id));
}

/**
 * Get blocking statistics for debugging.
 */
export function getBlockingStats(index: BlockingIndex): {
  nameTokenCount: number;
  phoneticCodeCount: number;
  typeCount: number;
  avgEntitiesPerToken: number;
} {
  let totalTokenEntities = 0;
  for (const set of index.byNameToken.values()) {
    totalTokenEntities += set.size;
  }

  return {
    nameTokenCount: index.byNameToken.size,
    phoneticCodeCount: index.byPhoneticCode.size,
    typeCount: index.byType.size,
    avgEntitiesPerToken:
      index.byNameToken.size > 0
        ? totalTokenEntities / index.byNameToken.size
        : 0,
  };
}
