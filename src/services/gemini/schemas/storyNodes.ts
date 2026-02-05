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
  'CAUSES', 'ENABLES', 'PREVENTS', 'HAPPENS_BEFORE',
  // Layer 3 (structural/relational)
  'PARTICIPATES_IN', 'LOCATED_AT', 'PART_OF', 'MEMBER_OF',
  'POSSESSES', 'CONNECTED_TO', 'OPPOSES', 'ABOUT',
  // System
  'BELONGS_TO_THREAD',
  // Fallback
  'RELATED_TO',
];

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
  },
  required: ['type', 'name', 'description', 'mentions'],
};

const connectionSchema = {
  type: GeminiType.OBJECT,
  properties: {
    fromName: { type: GeminiType.STRING },
    toName: { type: GeminiType.STRING },
    edgeType: { type: GeminiType.STRING, enum: EDGE_TYPE_ENUM },
    description: { type: GeminiType.STRING },
    strength: { type: GeminiType.NUMBER, nullable: true },
  },
  required: ['fromName', 'toName', 'edgeType', 'description'],
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

/** Schema for fresh text analysis */
export const analyzeResponseSchema = {
  type: GeminiType.OBJECT,
  properties: {
    nodes: {
      type: GeminiType.ARRAY,
      items: nodeSchema,
    },
    connections: {
      type: GeminiType.ARRAY,
      items: connectionSchema,
    },
    narrativeThreads: {
      type: GeminiType.ARRAY,
      items: narrativeThreadSchema,
      nullable: true,
    },
  },
  required: ['nodes', 'connections'],
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
