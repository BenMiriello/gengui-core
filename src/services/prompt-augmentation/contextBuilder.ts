/**
 * Context building from FalkorDB queries
 */

import { graphService } from '../graph/graph.service';
import { generateEmbedding } from '../embeddings';
import { logger } from '../../utils/logger';
import type { PromptContext, PromptEnhancementSettings } from './promptBuilder';

export async function buildContext(
  documentContent: string,
  documentId: string,
  userId: string,
  selectedText: string,
  startChar: number,
  endChar: number,
  settings: PromptEnhancementSettings
): Promise<PromptContext> {
  const context: PromptContext = {
    selectedText,
  };

  if (settings.useNarrativeContext) {
    let nodes;
    try {
      const queryEmbedding = await generateEmbedding(selectedText);
      nodes = await graphService.findSimilarNodes(queryEmbedding, documentId, userId, 10);
    } catch (err) {
      logger.warn({ error: err }, 'Semantic retrieval failed, falling back to full node list');
      nodes = await graphService.getStoryNodesForDocument(documentId, userId);
    }

    if (nodes.length > 0) {
      const connections = await graphService.getStoryConnectionsForDocument(documentId);
      context.storyContext = convertNodeTreeToText(nodes, connections);
    }
  }

  if (settings.charsBefore > 0) {
    const beforeStart = Math.max(0, startChar - settings.charsBefore);
    context.textBefore = documentContent.substring(beforeStart, startChar);
  }

  if (settings.charsAfter > 0) {
    const afterEnd = Math.min(documentContent.length, endChar + settings.charsAfter);
    context.textAfter = documentContent.substring(endChar, afterEnd);
  }

  return context;
}

function convertNodeTreeToText(
  nodes: any[],
  connections: any[]
): string {
  const sections: string[] = ['STORY CONTEXT:\n'];

  const nodesByType: Record<string, any[]> = {
    character: [],
    location: [],
    event: [],
    concept: [],
    other: [],
  };

  for (const node of nodes) {
    nodesByType[node.type]?.push(node);
  }

  if (nodesByType.character.length > 0) {
    sections.push('\nCHARACTERS:');
    for (const node of nodesByType.character) {
      sections.push(`- ${node.name}: ${node.description}`);
    }
  }

  if (nodesByType.location.length > 0) {
    sections.push('\nLOCATIONS:');
    for (const node of nodesByType.location) {
      sections.push(`- ${node.name}: ${node.description}`);
    }
  }

  if (nodesByType.event.length > 0) {
    sections.push('\nEVENTS:');
    for (const node of nodesByType.event) {
      sections.push(`- ${node.name}: ${node.description}`);
    }
  }

  if (nodesByType.concept.length > 0) {
    sections.push('\nCONCEPTS:');
    for (const node of nodesByType.concept) {
      sections.push(`- ${node.name}: ${node.description}`);
    }
  }

  if (nodesByType.other.length > 0) {
    sections.push('\nOTHER ELEMENTS:');
    for (const node of nodesByType.other) {
      sections.push(`- ${node.name}: ${node.description}`);
    }
  }

  if (connections.length > 0) {
    sections.push('\nRELATIONSHIPS:');
    const nodeMap = new Map(nodes.map(n => [n.id, n.name]));
    for (const conn of connections) {
      const fromName = nodeMap.get(conn.fromNodeId);
      const toName = nodeMap.get(conn.toNodeId);
      if (fromName && toName) {
        const edgeLabel = conn.edgeType || 'RELATED_TO';
        sections.push(`- ${fromName} --[${edgeLabel}]--> ${toName}: ${conn.description}`);
      }
    }
  }

  return sections.join('\n');
}
