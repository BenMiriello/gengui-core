import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { logger } from '../utils/logger';

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  logger.warn('GEMINI_API_KEY not configured');
}

const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

export interface StoryNodePassage {
  text: string;
  context?: string;
}

export interface StoryNodeResult {
  type: 'character' | 'location' | 'event' | 'other';
  name: string;
  description: string;
  passages: StoryNodePassage[];
  metadata?: Record<string, any>;
}

export interface StoryConnectionResult {
  fromName: string;
  toName: string;
  description: string;
}

export interface AnalysisResult {
  nodes: StoryNodeResult[];
  connections: StoryConnectionResult[];
}

const responseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    nodes: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          type: {
            type: SchemaType.STRING,
            enum: ['character', 'location', 'event', 'other'],
          },
          name: { type: SchemaType.STRING },
          description: { type: SchemaType.STRING },
          passages: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                text: { type: SchemaType.STRING },
                context: { type: SchemaType.STRING, nullable: true },
              },
              required: ['text'],
            },
          },
        },
        required: ['type', 'name', 'description', 'passages'],
      },
    },
    connections: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          fromName: { type: SchemaType.STRING },
          toName: { type: SchemaType.STRING },
          description: { type: SchemaType.STRING },
        },
        required: ['fromName', 'toName', 'description'],
      },
    },
  },
  required: ['nodes', 'connections'],
};

export async function analyzeText(content: string): Promise<AnalysisResult> {
  if (!genAI) {
    throw new Error('Gemini API client not initialized - GEMINI_API_KEY missing');
  }

  const model = genAI.getGenerativeModel({
    model: 'gemini-3-flash-preview',
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: responseSchema as any,
    },
  });

  const prompt = `Analyze the following narrative text and extract story elements:

Extract:
1. **Characters**: People or sentient beings in the story
2. **Locations**: Places where events occur
3. **Events**: Significant actions or occurrences in the story
4. **Other**: Any other important story elements (objects, concepts, etc.)

Only create nodes for objects that contribute meaningfully to the story and/or exist separate from a place or character. If they can sufficiently be described as part of a location or in the character description, do not include them as separate nodes.

Only create nodes for events that are significant to the overall narrative, involve multiple characters/locations, or have a lasting impact on the story.

Only create nodes for locations if they are mentioned or described or are significant to the story.

Events should have connections to all characters and places that are directly involved.

For each element:
- Provide a concise name
- Write a brief description (1-3 sentences)
- Include text passages where this element appears (30-100 characters each, with enough context to find them uniquely in the document)

Also identify connections/relationships between elements with brief descriptions.

Text to analyze:
${content}`;

  try {
    const result = await model.generateContent(prompt);

    console.log('=== GEMINI API RESULT ===');
    console.log('result exists:', !!result);
    console.log('result.response exists:', !!result?.response);
    console.log('result.response.candidates:', result?.response?.candidates);
    console.log('========================');

    if (!result?.response) {
      throw new Error('Unable to analyze document. Please try again.');
    }

    const response = result.response;

    // Check if the response was blocked or has no candidates
    if (!response.candidates || response.candidates.length === 0) {
      const blockReason = response.promptFeedback?.blockReason;
      if (blockReason) {
        console.error('Content was blocked:', blockReason);
        throw new Error('Unable to analyze document. The content may contain inappropriate material.');
      }
      throw new Error('Unable to analyze document. The content may have been filtered. Please try again.');
    }

    const text = response.text();
    console.log('Gemini response text length:', text.length);

    if (!text || text.trim().length === 0) {
      console.error('Gemini returned empty response');
      throw new Error('Unable to analyze document. The content may be too short or unclear. Please try again.');
    }

    const parsed = JSON.parse(text) as AnalysisResult;

    console.log('Story elements extracted:', {
      nodesCount: parsed.nodes.length,
      connectionsCount: parsed.connections.length
    });

    return parsed;
  } catch (error: any) {
    console.error('=== GEMINI API ERROR ===');
    console.error('Error:', error);
    console.error('Error message:', error?.message);
    console.error('Error stack:', error?.stack);
    console.error('========================');

    // Handle specific error types
    if (error?.message?.includes('quota')) {
      throw new Error('API quota exceeded. Please try again later.');
    }

    if (error?.message?.includes('rate limit')) {
      throw new Error('Rate limit exceeded. Please wait a moment and try again.');
    }

    if (error?.message?.includes('404')) {
      throw new Error('Analysis service not available. Please contact support.');
    }

    if (error?.message?.includes('JSON')) {
      throw new Error('Failed to parse analysis results. Please try again.');
    }

    // Re-throw if it's already a formatted error message
    if (error?.message?.includes('Unable to analyze') ||
        error?.message?.includes('quota') ||
        error?.message?.includes('rate limit') ||
        error?.message?.includes('inappropriate material')) {
      throw error;
    }

    throw new Error(`Analysis failed: ${error?.message || 'Unknown error'}. Please try again.`);
  }
}
