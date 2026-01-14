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
  const prompt = `Analyze the following narrative text and extract story elements.

CRITICAL RULES - FOLLOW EXACTLY:

1. **Character descriptions**: MUST focus on physical appearance, personality traits, role, and motivations. DO NOT include plot events or actions they take. Keep relationships separate.

2. **Location descriptions**: MUST describe physical features, atmosphere, and appearance. DO NOT describe events that happen there.

3. **Connections**: Every node MUST have at least one connection. No isolated nodes. No isolated node groups (all nodes must connect into a single graph).

Extract these element types:
- **Characters**: People or sentient beings. Describe their physical appearance first including specific details, then personality, role, and motivations (but not plot events or actions they take).
- **Locations**: Places where events occur. Describe their appearance, key features, atmosphere, significance.
- **Events**: Significant plot actions. Only create for major narrative moments that involve multiple characters/locations or have lasting story impact.
- **Other**: Important story elements (objects, concepts) that exist independently and contribute meaningfully to the narrative.

Only create nodes for:
- Events that are truly significant to the overall narrative
- Locations that are actually described or mentioned in the text
- Objects that cannot be sufficiently described as part of a character or location

For each element provide:
- Concise name
- Brief description (1-4 sentences following the rules above)
- Passages: 1-3 Short keywords or phrases (short but exact verbatim quotes of 3 to 15 words) from the text. These must be passages that define the element the most, or are most significant for its character or meaning or role. Must not simply repeat the name or description, though it can optionally augment or support the description. Must be somewhat specific and not so generic that they would match to irrelevant passages.

Identify connections/relationships between elements with brief descriptions.

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
