/**
 * Context building from DB queries
 */

import { db } from '../../config/database';
import { storyNodes, storyNodeConnections } from '../../models/schema';
import { eq, and, inArray } from 'drizzle-orm';
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

  // Add narrative context if requested
  if (settings.useNarrativeContext) {
    const nodes = await db
      .select()
      .from(storyNodes)
      .where(and(eq(storyNodes.documentId, documentId), eq(storyNodes.userId, userId)));

    if (nodes.length > 0) {
      // Get connections
      const nodeIds = nodes.map(n => n.id);
      const connections = await db
        .select()
        .from(storyNodeConnections)
        .where(
          and(
            inArray(storyNodeConnections.fromNodeId, nodeIds),
            inArray(storyNodeConnections.toNodeId, nodeIds)
          )
        );

      // Convert to text
      context.storyContext = convertNodeTreeToText(nodes, connections);
    }
  }

  // Add surrounding text context
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

  // Group nodes by type
  const nodesByType: Record<string, any[]> = {
    character: [],
    location: [],
    event: [],
    other: [],
  };

  for (const node of nodes) {
    nodesByType[node.type]?.push(node);
  }

  // Add characters
  if (nodesByType.character.length > 0) {
    sections.push('\nCHARACTERS:');
    for (const node of nodesByType.character) {
      sections.push(`- ${node.name} (${node.type}): ${node.description}`);
    }
  }

  // Add locations
  if (nodesByType.location.length > 0) {
    sections.push('\nLOCATIONS:');
    for (const node of nodesByType.location) {
      sections.push(`- ${node.name} (${node.type}): ${node.description}`);
    }
  }

  // Add events
  if (nodesByType.event.length > 0) {
    sections.push('\nEVENTS:');
    for (const node of nodesByType.event) {
      sections.push(`- ${node.name} (${node.type}): ${node.description}`);
    }
  }

  // Add other elements
  if (nodesByType.other.length > 0) {
    sections.push('\nOTHER ELEMENTS:');
    for (const node of nodesByType.other) {
      sections.push(`- ${node.name} (${node.type}): ${node.description}`);
    }
  }

  // Add relationships
  if (connections.length > 0) {
    sections.push('\nRELATIONSHIPS:');
    const nodeMap = new Map(nodes.map(n => [n.id, n.name]));
    for (const conn of connections) {
      const fromName = nodeMap.get(conn.fromNodeId);
      const toName = nodeMap.get(conn.toNodeId);
      if (fromName && toName) {
        sections.push(`- ${fromName} → ${toName}: ${conn.description}`);
      }
    }
  }

  return sections.join('\n');
}
