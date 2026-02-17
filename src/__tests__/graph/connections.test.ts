import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { GraphService } from '../../services/graph/graph.service';
import type { StoryNodeResult } from '../../types/storyNodes';

// Skip if FalkorDB is not available (detected in preload.ts)
const isFalkorDBAvailable = process.env.FALKORDB_AVAILABLE === 'true';

// Create our own instance to bypass any mocks applied to the singleton
const graphService = new GraphService();

function createNodeInput(
  overrides: Partial<StoryNodeResult> & { type: StoryNodeResult['type']; name: string }
): StoryNodeResult {
  return {
    description: '',
    mentions: [],
    ...overrides,
  };
}

(isFalkorDBAvailable ? describe : describe.skip)('Graph: Connections', () => {
  // Unique IDs for this test file - enables parallel execution with other graph test files
  const testUserId = 'graph-test-connections';
  const testDocumentId = 'graph-test-connections-doc';

  beforeAll(async () => {
    await graphService.connect();
    await graphService.initializeIndexes();
  });

  afterAll(async () => {
    // Clean up this test file's data before disconnecting
    await graphService.query(`MATCH (n {userId: '${testUserId}'}) DETACH DELETE n`);
    await graphService.disconnect();
  });

  beforeEach(async () => {
    // Only clear this test file's nodes - allows parallel execution
    await graphService.query(`MATCH (n {userId: '${testUserId}'}) DETACH DELETE n`);
  });

  describe('createStoryConnection', () => {
    test('creates connection between two nodes', async () => {
      const fromId = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Alice',
        })
      );
      const toId = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'location',
          name: 'Castle',
        })
      );

      const connectionId = await graphService.createStoryConnection(
        fromId,
        toId,
        'LOCATED_AT',
        'Alice lives in the castle'
      );

      expect(connectionId).toBeDefined();
      expect(typeof connectionId).toBe('string');
    });

    test('creates connection with strength property', async () => {
      const fromId = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'event',
          name: 'Cause Event',
        })
      );
      const toId = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'event',
          name: 'Effect Event',
        })
      );

      const connectionId = await graphService.createStoryConnection(fromId, toId, 'CAUSES', null, {
        strength: 0.8,
      });

      expect(connectionId).toBeDefined();
    });

    test('supports all causal edge types', async () => {
      const causalTypes = ['CAUSES', 'ENABLES', 'PREVENTS', 'HAPPENS_BEFORE'] as const;

      for (const edgeType of causalTypes) {
        const fromId = await graphService.createStoryNode(
          testDocumentId,
          testUserId,
          createNodeInput({
            type: 'event',
            name: `From ${edgeType}`,
          })
        );
        const toId = await graphService.createStoryNode(
          testDocumentId,
          testUserId,
          createNodeInput({
            type: 'event',
            name: `To ${edgeType}`,
          })
        );

        const connectionId = await graphService.createStoryConnection(fromId, toId, edgeType, null);
        expect(connectionId).toBeDefined();
      }
    });

    test('supports all structural edge types', async () => {
      const structuralTypes = [
        'PARTICIPATES_IN',
        'LOCATED_AT',
        'PART_OF',
        'MEMBER_OF',
        'POSSESSES',
        'CONNECTED_TO',
        'OPPOSES',
        'ABOUT',
        'RELATED_TO',
      ] as const;

      for (const edgeType of structuralTypes) {
        const fromId = await graphService.createStoryNode(
          testDocumentId,
          testUserId,
          createNodeInput({
            type: 'character',
            name: `From ${edgeType}`,
          })
        );
        const toId = await graphService.createStoryNode(
          testDocumentId,
          testUserId,
          createNodeInput({
            type: 'concept',
            name: `To ${edgeType}`,
          })
        );

        const connectionId = await graphService.createStoryConnection(fromId, toId, edgeType, null);
        expect(connectionId).toBeDefined();
      }
    });

    test('throws for invalid edge type', async () => {
      const fromId = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'From',
        })
      );
      const toId = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'To',
        })
      );

      await expect(
        graphService.createStoryConnection(fromId, toId, 'INVALID_TYPE' as any, null)
      ).rejects.toThrow('Invalid edge type');
    });
  });

  describe('getStoryConnectionsForDocument', () => {
    test('returns empty array for document with no connections', async () => {
      await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Lonely Node',
        })
      );

      const connections = await graphService.getStoryConnectionsForDocument(testDocumentId);
      expect(connections).toEqual([]);
    });

    test('returns all connections for a document', async () => {
      const node1 = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Alice',
        })
      );
      const node2 = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'location',
          name: 'Castle',
        })
      );
      const node3 = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'event',
          name: 'Battle',
        })
      );

      await graphService.createStoryConnection(node1, node2, 'LOCATED_AT', null);
      await graphService.createStoryConnection(node1, node3, 'PARTICIPATES_IN', null);

      const connections = await graphService.getStoryConnectionsForDocument(testDocumentId);
      expect(connections).toHaveLength(2);
    });

    test('returns connection properties', async () => {
      const node1 = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'event',
          name: 'Cause',
        })
      );
      const node2 = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'event',
          name: 'Effect',
        })
      );

      await graphService.createStoryConnection(node1, node2, 'CAUSES', 'A leads to B', {
        strength: 0.9,
      });

      const connections = await graphService.getStoryConnectionsForDocument(testDocumentId);
      expect(connections).toHaveLength(1);

      const conn = connections[0];
      expect(conn.fromNodeId).toBe(node1);
      expect(conn.toNodeId).toBe(node2);
      expect(conn.edgeType).toBe('CAUSES');
      expect(conn.description).toBe('A leads to B');
      expect(conn.strength).toBe(0.9);
      expect(conn.createdAt).toBeDefined();
    });

    test('excludes soft-deleted connections', async () => {
      const node1 = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Node 1',
        })
      );
      const node2 = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Node 2',
        })
      );
      const node3 = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Node 3',
        })
      );

      await graphService.createStoryConnection(node1, node2, 'CONNECTED_TO', null);
      await graphService.createStoryConnection(node2, node3, 'CONNECTED_TO', null);

      await graphService.softDeleteStoryConnection(node1, node2);

      const connections = await graphService.getStoryConnectionsForDocument(testDocumentId);
      expect(connections).toHaveLength(1);
      expect(connections[0].fromNodeId).toBe(node2);
      expect(connections[0].toNodeId).toBe(node3);
    });

    test('excludes connections to/from soft-deleted nodes', async () => {
      const node1 = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Active Node',
        })
      );
      const node2 = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Deleted Node',
        })
      );

      await graphService.createStoryConnection(node1, node2, 'CONNECTED_TO', null);
      await graphService.softDeleteStoryNode(node2);

      const connections = await graphService.getStoryConnectionsForDocument(testDocumentId);
      expect(connections).toEqual([]);
    });
  });

  describe('softDeleteStoryConnection', () => {
    test('marks connection as deleted', async () => {
      const node1 = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Node 1',
        })
      );
      const node2 = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Node 2',
        })
      );

      await graphService.createStoryConnection(node1, node2, 'CONNECTED_TO', null);

      let connections = await graphService.getStoryConnectionsForDocument(testDocumentId);
      expect(connections).toHaveLength(1);

      await graphService.softDeleteStoryConnection(node1, node2);

      connections = await graphService.getStoryConnectionsForDocument(testDocumentId);
      expect(connections).toEqual([]);
    });
  });

  describe('wouldCreateCycle', () => {
    test('returns false when no cycle would be created', async () => {
      const node1 = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'event',
          name: 'Event 1',
        })
      );
      const node2 = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'event',
          name: 'Event 2',
        })
      );

      const wouldCycle = await graphService.wouldCreateCycle(node1, node2);
      expect(wouldCycle).toBe(false);
    });

    test('returns true when cycle would be created (direct)', async () => {
      const node1 = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'event',
          name: 'Event 1',
        })
      );
      const node2 = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'event',
          name: 'Event 2',
        })
      );

      await graphService.createStoryConnection(node1, node2, 'CAUSES', null);

      const wouldCycle = await graphService.wouldCreateCycle(node2, node1);
      expect(wouldCycle).toBe(true);
    });

    test('returns true when cycle would be created (transitive)', async () => {
      const node1 = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'event',
          name: 'Event 1',
        })
      );
      const node2 = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'event',
          name: 'Event 2',
        })
      );
      const node3 = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'event',
          name: 'Event 3',
        })
      );

      await graphService.createStoryConnection(node1, node2, 'CAUSES', null);
      await graphService.createStoryConnection(node2, node3, 'CAUSES', null);

      const wouldCycle = await graphService.wouldCreateCycle(node3, node1);
      expect(wouldCycle).toBe(true);
    });

    test('throws error when creating causal edge that would create cycle', async () => {
      const node1 = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'event',
          name: 'Event 1',
        })
      );
      const node2 = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'event',
          name: 'Event 2',
        })
      );

      await graphService.createStoryConnection(node1, node2, 'CAUSES', null);

      await expect(
        graphService.createStoryConnection(node2, node1, 'ENABLES', null)
      ).rejects.toThrow('would create a cycle');
    });
  });
});
