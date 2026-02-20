/**
 * Gemini-specific JSON schemas for structured output.
 * These define the expected response format from Gemini API.
 */
import { GeminiType } from '../core';

const passageSchema = {
  type: GeminiType.OBJECT,
  properties: {
    text: { type: GeminiType.STRING },
    context: { type: GeminiType.STRING, nullable: true },
  },
  required: ['text'],
};

const EDGE_TYPE_ENUM = [
  // Layer 2 (causal/temporal)
  'CAUSES',
  'ENABLES',
  'PREVENTS',
  'HAPPENS_BEFORE',
  // Layer 3 (structural/relational)
  'PARTICIPATES_IN',
  'LOCATED_AT',
  'PART_OF',
  'MEMBER_OF',
  'POSSESSES',
  'CONNECTED_TO',
  'OPPOSES',
  'ABOUT',
  // System
  'BELONGS_TO_THREAD',
  // Fallback
  'RELATED_TO',
];

const eventRangeSchema = {
  type: GeminiType.OBJECT,
  properties: {
    startMarker: { type: GeminiType.STRING },
    endMarker: { type: GeminiType.STRING },
  },
  required: ['startMarker', 'endMarker'],
};

const nodeSchema = {
  type: GeminiType.OBJECT,
  properties: {
    type: {
      type: GeminiType.STRING,
      enum: ['character', 'location', 'event', 'concept', 'other'],
    },
    name: { type: GeminiType.STRING },
    description: { type: GeminiType.STRING },
    aliases: {
      type: GeminiType.ARRAY,
      items: { type: GeminiType.STRING },
      nullable: true,
    },
    mentions: {
      type: GeminiType.ARRAY,
      items: passageSchema,
    },
    documentOrder: { type: GeminiType.INTEGER, nullable: true },
    eventRanges: {
      type: GeminiType.ARRAY,
      items: eventRangeSchema,
      nullable: true,
    },
  },
  required: ['type', 'name', 'description', 'mentions'],
};

const narrativeThreadSchema = {
  type: GeminiType.OBJECT,
  properties: {
    name: { type: GeminiType.STRING },
    isPrimary: { type: GeminiType.BOOLEAN },
    eventNames: {
      type: GeminiType.ARRAY,
      items: { type: GeminiType.STRING },
    },
  },
  required: ['name', 'isPrimary', 'eventNames'],
};

/**
 * Schema for facet-first extraction (flattened for Gemini depth limit).
 * Uses parallel arrays with name-based foreign keys instead of nesting.
 * Max depth: 3 (root -> array -> object with primitives)
 */
const entityBaseSchema = {
  type: GeminiType.OBJECT,
  properties: {
    name: { type: GeminiType.STRING },
    type: {
      type: GeminiType.STRING,
      enum: ['character', 'location', 'event', 'concept', 'other'],
    },
    documentOrder: { type: GeminiType.INTEGER, nullable: true },
  },
  required: ['name', 'type'],
};

const facetFlatSchema = {
  type: GeminiType.OBJECT,
  properties: {
    entityName: { type: GeminiType.STRING },
    facetType: {
      type: GeminiType.STRING,
      enum: ['name', 'appearance', 'trait', 'state'],
    },
    content: { type: GeminiType.STRING },
  },
  required: ['entityName', 'facetType', 'content'],
};

const mentionFlatSchema = {
  type: GeminiType.OBJECT,
  properties: {
    entityName: { type: GeminiType.STRING },
    text: { type: GeminiType.STRING },
    context: { type: GeminiType.STRING, nullable: true },
  },
  required: ['entityName', 'text'],
};

/** Schema for incremental node updates */
export const updateNodesResponseSchema = {
  type: GeminiType.OBJECT,
  properties: {
    add: {
      type: GeminiType.ARRAY,
      items: nodeSchema,
    },
    update: {
      type: GeminiType.ARRAY,
      items: {
        type: GeminiType.OBJECT,
        properties: {
          id: { type: GeminiType.STRING },
          name: { type: GeminiType.STRING, nullable: true },
          description: { type: GeminiType.STRING, nullable: true },
          mentions: {
            type: GeminiType.ARRAY,
            nullable: true,
            items: passageSchema,
          },
        },
        required: ['id'],
      },
    },
    delete: {
      type: GeminiType.ARRAY,
      items: { type: GeminiType.STRING },
    },
    connectionUpdates: {
      type: GeminiType.OBJECT,
      properties: {
        add: {
          type: GeminiType.ARRAY,
          items: {
            type: GeminiType.OBJECT,
            properties: {
              fromId: { type: GeminiType.STRING, nullable: true },
              toId: { type: GeminiType.STRING, nullable: true },
              fromName: { type: GeminiType.STRING, nullable: true },
              toName: { type: GeminiType.STRING, nullable: true },
              edgeType: { type: GeminiType.STRING, enum: EDGE_TYPE_ENUM },
              description: { type: GeminiType.STRING },
              strength: { type: GeminiType.NUMBER, nullable: true },
            },
            required: ['edgeType', 'description'],
          },
        },
        delete: {
          type: GeminiType.ARRAY,
          items: {
            type: GeminiType.OBJECT,
            properties: {
              fromId: { type: GeminiType.STRING },
              toId: { type: GeminiType.STRING },
            },
            required: ['fromId', 'toId'],
          },
        },
      },
      required: ['add', 'delete'],
    },
    narrativeThreads: {
      type: GeminiType.ARRAY,
      items: narrativeThreadSchema,
      nullable: true,
    },
  },
  required: ['add', 'update', 'delete', 'connectionUpdates'],
};

// =============================================================================
// Multi-Stage Pipeline Schemas
// =============================================================================

/**
 * Stage 1: Entity + Facet Extraction (per segment)
 * Flat parallel arrays for Gemini depth compliance.
 */
export const stage1ExtractEntitiesSchema = {
  type: GeminiType.OBJECT,
  properties: {
    entities: {
      type: GeminiType.ARRAY,
      items: entityBaseSchema,
    },
    facets: {
      type: GeminiType.ARRAY,
      items: facetFlatSchema,
    },
    mentions: {
      type: GeminiType.ARRAY,
      items: mentionFlatSchema,
    },
  },
  required: ['entities', 'facets', 'mentions'],
};

/**
 * Stage 3: Entity Resolution
 * Decision for single entity resolution.
 */
const resolutionFacetSchema = {
  type: GeminiType.OBJECT,
  properties: {
    type: {
      type: GeminiType.STRING,
      enum: ['name', 'appearance', 'trait', 'state'],
    },
    content: { type: GeminiType.STRING },
  },
  required: ['type', 'content'],
};

export const stage3ResolveEntitySchema = {
  type: GeminiType.OBJECT,
  properties: {
    decision: {
      type: GeminiType.STRING,
      enum: ['MERGE', 'UPDATE', 'ADD_FACET', 'NEW'],
    },
    targetEntityId: { type: GeminiType.STRING, nullable: true },
    newFacets: {
      type: GeminiType.ARRAY,
      items: resolutionFacetSchema,
      nullable: true,
    },
    reason: { type: GeminiType.STRING },
  },
  required: ['decision', 'reason'],
};

/**
 * Stage 3: Batch Entity Resolution
 */
const batchResolutionItemSchema = {
  type: GeminiType.OBJECT,
  properties: {
    extractedIndex: { type: GeminiType.INTEGER },
    decision: {
      type: GeminiType.STRING,
      enum: ['MERGE', 'UPDATE', 'ADD_FACET', 'NEW'],
    },
    targetEntityId: { type: GeminiType.STRING, nullable: true },
    newFacets: {
      type: GeminiType.ARRAY,
      items: resolutionFacetSchema,
      nullable: true,
    },
    reason: { type: GeminiType.STRING },
  },
  required: ['extractedIndex', 'decision', 'reason'],
};

export const stage3BatchResolveSchema = {
  type: GeminiType.OBJECT,
  properties: {
    resolutions: {
      type: GeminiType.ARRAY,
      items: batchResolutionItemSchema,
    },
  },
  required: ['resolutions'],
};

/**
 * Stage 4: Relationship Extraction
 */
const relationshipSchema = {
  type: GeminiType.OBJECT,
  properties: {
    fromId: { type: GeminiType.STRING },
    toId: { type: GeminiType.STRING },
    edgeType: { type: GeminiType.STRING, enum: EDGE_TYPE_ENUM },
    description: { type: GeminiType.STRING },
    strength: { type: GeminiType.NUMBER, nullable: true },
  },
  required: ['fromId', 'toId', 'edgeType', 'description'],
};

export const stage4ExtractRelationshipsSchema = {
  type: GeminiType.OBJECT,
  properties: {
    relationships: {
      type: GeminiType.ARRAY,
      items: relationshipSchema,
    },
  },
  required: ['relationships'],
};

/**
 * Stage 5: Higher-Order Analysis
 */
const narrativeThreadOutputSchema = {
  type: GeminiType.OBJECT,
  properties: {
    name: { type: GeminiType.STRING },
    isPrimary: { type: GeminiType.BOOLEAN },
    eventIds: {
      type: GeminiType.ARRAY,
      items: { type: GeminiType.STRING },
    },
    description: { type: GeminiType.STRING, nullable: true },
  },
  required: ['name', 'isPrimary', 'eventIds'],
};

/**
 * Flattened arc phase schema to avoid Gemini depth limits.
 * Uses characterId + phaseIndex as composite key.
 */
const arcPhaseSchema = {
  type: GeminiType.OBJECT,
  properties: {
    characterId: { type: GeminiType.STRING },
    phaseIndex: { type: GeminiType.INTEGER },
    phaseName: { type: GeminiType.STRING },
    arcType: {
      type: GeminiType.STRING,
      enum: ['transformation', 'growth', 'fall', 'revelation', 'static'],
    },
    triggerEventId: { type: GeminiType.STRING, nullable: true },
    stateFacets: {
      type: GeminiType.ARRAY,
      items: { type: GeminiType.STRING },
    },
  },
  required: [
    'characterId',
    'phaseIndex',
    'phaseName',
    'arcType',
    'stateFacets',
  ],
};

export const stage5HigherOrderSchema = {
  type: GeminiType.OBJECT,
  properties: {
    narrativeThreads: {
      type: GeminiType.ARRAY,
      items: narrativeThreadOutputSchema,
    },
    arcPhases: {
      type: GeminiType.ARRAY,
      items: arcPhaseSchema,
    },
  },
  required: ['narrativeThreads', 'arcPhases'],
};

/**
 * Stage 5: Thread Refinement (simpler)
 */
const refinedThreadSchema = {
  type: GeminiType.OBJECT,
  properties: {
    index: { type: GeminiType.INTEGER },
    name: { type: GeminiType.STRING },
    isPrimary: { type: GeminiType.BOOLEAN },
    description: { type: GeminiType.STRING },
  },
  required: ['index', 'name', 'isPrimary', 'description'],
};

export const stage5RefineThreadsSchema = {
  type: GeminiType.OBJECT,
  properties: {
    threads: {
      type: GeminiType.ARRAY,
      items: refinedThreadSchema,
    },
  },
  required: ['threads'],
};
