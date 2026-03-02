import { logger } from '../../utils/logger.js';
import { mentionService } from '../mentions/mention.service.js';
import type { StoredFacet } from './graph.service.js';
import { graphService } from './graph.service.js';

const PRONOUNS = new Set([
  // Subject pronouns
  'i',
  'you',
  'he',
  'she',
  'it',
  'we',
  'they',
  // Object pronouns
  'me',
  'him',
  'her',
  'us',
  'them',
  // Possessive pronouns
  'my',
  'mine',
  'your',
  'yours',
  'his',
  'hers',
  'its',
  'our',
  'ours',
  'their',
  'theirs',
  // Reflexive pronouns
  'myself',
  'yourself',
  'himself',
  'herself',
  'itself',
  'ourselves',
  'yourselves',
  'themselves',
  // Demonstrative pronouns
  'this',
  'that',
  'these',
  'those',
  // Indefinite pronouns (common ones)
  'anyone',
  'anybody',
  'anything',
  'everyone',
  'everybody',
  'everything',
  'someone',
  'somebody',
  'something',
  'no one',
  'nobody',
  'nothing',
  'one',
  'ones',
  'another',
  'other',
  'others',
  // Interrogative pronouns
  'who',
  'whom',
  'whose',
  'what',
  'which',
  // Relative pronouns (covered by interrogative)
]);

interface FacetWithMentionCount {
  facet: StoredFacet;
  mentionCount: number;
}

/**
 * Computes the primary name for an entity from its name facets.
 *
 * Algorithm:
 * 1. Check for starred name facet (user override) - use if present
 * 2. Get all name facets
 * 3. Filter out pronouns
 * 4. Sort by mention count (descending)
 * 5. Return most-mentioned non-pronoun name
 * 6. Fallback to "Unknown Entity" if no valid names
 *
 * @param entityId - The entity node ID
 * @returns The computed primary name
 */
export async function computePrimaryName(entityId: string): Promise<string> {
  try {
    // Get all facets for this entity
    const facets = await graphService.getFacetsForEntity(entityId);

    // Filter to name facets only
    const nameFacets = facets.filter((f) => f.type === 'name');

    if (nameFacets.length === 0) {
      logger.warn({ entityId }, 'Entity has no name facets');
      return 'Unknown Entity';
    }

    // TODO: Check for starred facet (user override) when isStarred field is implemented
    // const starredFacet = nameFacets.find(f => f.isStarred);
    // if (starredFacet) {
    //   logger.debug({ entityId, name: starredFacet.content }, 'Using starred name facet');
    //   return starredFacet.content;
    // }

    // Get mention counts for all facets
    const mentionCounts =
      await mentionService.getMentionCountsByFacet(entityId);

    // Build array of facets with their mention counts
    const facetsWithCounts: FacetWithMentionCount[] = nameFacets.map(
      (facet) => ({
        facet,
        mentionCount: mentionCounts.get(facet.id) || 0,
      }),
    );

    // Filter out pronouns
    const nonPronounFacets = facetsWithCounts.filter((fc) => {
      const normalized = fc.facet.content.toLowerCase().trim();
      return !PRONOUNS.has(normalized);
    });

    if (nonPronounFacets.length === 0) {
      logger.warn({ entityId }, 'Entity has only pronoun name facets');
      return 'Unknown Entity';
    }

    // Sort by mention count descending, then alphabetically for ties
    nonPronounFacets.sort((a, b) => {
      if (a.mentionCount !== b.mentionCount) {
        return b.mentionCount - a.mentionCount;
      }
      return a.facet.content.localeCompare(b.facet.content);
    });

    const primaryName = nonPronounFacets[0].facet.content;
    logger.debug(
      {
        entityId,
        primaryName,
        mentionCount: nonPronounFacets[0].mentionCount,
        totalNameFacets: nameFacets.length,
        nonPronounFacets: nonPronounFacets.length,
      },
      'Computed primary name',
    );

    return primaryName;
  } catch (error) {
    logger.error({ entityId, error }, 'Failed to compute primary name');
    return 'Unknown Entity';
  }
}

/**
 * Computes description for an entity.
 *
 * Priority:
 * 1. Use generated/derived description if present
 * 2. Otherwise, concatenate non-name facets (comma-separated, max 200 chars)
 * 3. Return null if no facets available
 *
 * @param entityId - The entity node ID
 * @param generatedDescription - Optional pre-generated description from LLM
 * @returns The computed description or null
 */
export async function computeDescription(
  entityId: string,
  generatedDescription?: string | null,
): Promise<string | null> {
  try {
    // Use generated description if available
    if (generatedDescription) {
      return generatedDescription;
    }

    // Get all facets for this entity
    const facets = await graphService.getFacetsForEntity(entityId);

    // Filter to non-name facets
    const descriptiveFacets = facets.filter((f) => f.type !== 'name');

    if (descriptiveFacets.length === 0) {
      return null;
    }

    // Concatenate facet contents with commas, limit to 200 chars
    const concatenated = descriptiveFacets
      .map((f) => f.content)
      .join(', ')
      .substring(0, 200);

    return concatenated || null;
  } catch (error) {
    logger.error({ entityId, error }, 'Failed to compute description');
    return null;
  }
}

/**
 * Recomputes and updates the primary name for an entity.
 * Call this whenever name facets are added, updated, or starred.
 *
 * @param entityId - The entity node ID
 * @returns The new primary name
 */
export async function recomputeAndUpdatePrimaryName(
  entityId: string,
): Promise<string> {
  const primaryName = await computePrimaryName(entityId);

  await graphService.updateStoryNode(entityId, { name: primaryName });

  logger.info({ entityId, primaryName }, 'Recomputed and updated primary name');

  return primaryName;
}
