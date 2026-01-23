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

const nodeSchema = {
  type: GeminiType.OBJECT,
  properties: {
    type: {
      type: GeminiType.STRING,
      enum: ['character', 'location', 'event', 'other'],
    },
    name: { type: GeminiType.STRING },
    description: { type: GeminiType.STRING },
    passages: {
      type: GeminiType.ARRAY,
      items: passageSchema,
    },
  },
  required: ['type', 'name', 'description', 'passages'],
};

const connectionSchema = {
  type: GeminiType.OBJECT,
  properties: {
    fromName: { type: GeminiType.STRING },
    toName: { type: GeminiType.STRING },
    description: { type: GeminiType.STRING },
  },
  required: ['fromName', 'toName', 'description'],
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
          passages: {
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
              description: { type: GeminiType.STRING },
            },
            required: ['description'],
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
  },
  required: ['add', 'update', 'delete', 'connectionUpdates'],
};
