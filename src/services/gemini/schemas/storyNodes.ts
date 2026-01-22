/**
 * Gemini-specific JSON schemas for structured output.
 * These define the expected response format from Gemini API.
 */
import { Type } from '@google/genai';

const passageSchema = {
  type: Type.OBJECT,
  properties: {
    text: { type: Type.STRING },
    context: { type: Type.STRING, nullable: true },
  },
  required: ['text'],
};

const nodeSchema = {
  type: Type.OBJECT,
  properties: {
    type: {
      type: Type.STRING,
      enum: ['character', 'location', 'event', 'other'],
    },
    name: { type: Type.STRING },
    description: { type: Type.STRING },
    passages: {
      type: Type.ARRAY,
      items: passageSchema,
    },
  },
  required: ['type', 'name', 'description', 'passages'],
};

const connectionSchema = {
  type: Type.OBJECT,
  properties: {
    fromName: { type: Type.STRING },
    toName: { type: Type.STRING },
    description: { type: Type.STRING },
  },
  required: ['fromName', 'toName', 'description'],
};

/** Schema for fresh text analysis */
export const analyzeResponseSchema = {
  type: Type.OBJECT,
  properties: {
    nodes: {
      type: Type.ARRAY,
      items: nodeSchema,
    },
    connections: {
      type: Type.ARRAY,
      items: connectionSchema,
    },
  },
  required: ['nodes', 'connections'],
};

/** Schema for incremental node updates */
export const updateNodesResponseSchema = {
  type: Type.OBJECT,
  properties: {
    add: {
      type: Type.ARRAY,
      items: nodeSchema,
    },
    update: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          name: { type: Type.STRING, nullable: true },
          description: { type: Type.STRING, nullable: true },
          passages: {
            type: Type.ARRAY,
            nullable: true,
            items: passageSchema,
          },
        },
        required: ['id'],
      },
    },
    delete: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    connectionUpdates: {
      type: Type.OBJECT,
      properties: {
        add: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              fromId: { type: Type.STRING, nullable: true },
              toId: { type: Type.STRING, nullable: true },
              fromName: { type: Type.STRING, nullable: true },
              toName: { type: Type.STRING, nullable: true },
              description: { type: Type.STRING },
            },
            required: ['description'],
          },
        },
        delete: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              fromId: { type: Type.STRING },
              toId: { type: Type.STRING },
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
