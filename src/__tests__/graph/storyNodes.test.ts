import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { GraphService } from '../../services/graph/graph.service';
import type { StoryNodeResult } from '../../types/storyNodes';

// Skip if FalkorDB is not available (detected in preload.ts)
const isFalkorDBAvailable = process.env.FALKORDB_AVAILABLE === 'true';

// Create our own instance to bypass any mocks applied to the singleton
const graphService = new GraphService();

function createNodeInput(
  overrides: Partial<StoryNodeResult> & {
    type: StoryNodeResult['type'];
    name: string;
  },
): StoryNodeResult {
  return {
    description: '',
    mentions: [],
    ...overrides,
  };
}

(isFalkorDBAvailable ? describe : describe.skip)('Graph: StoryNodes', () => {
  // Unique IDs for this test file - enables parallel execution with other graph test files
  const testUserId = 'graph-test-nodes';
  const testDocumentId = 'graph-test-nodes-doc';

  beforeAll(async () => {
    await graphService.connect();
    await graphService.initializeIndexes();
  });

  afterAll(async () => {
    // Clean up all test nodes (including test-specific 'other-user' nodes)
    await graphService.query(
      `MATCH (n) WHERE n.userId IN ['${testUserId}', 'other-user', 'different-user'] DETACH DELETE n`,
    );
    await graphService.disconnect();
  });

  beforeEach(async () => {
    // Clean up all test nodes before each test
    await graphService.query(
      `MATCH (n) WHERE n.userId IN ['${testUserId}', 'other-user', 'different-user'] DETACH DELETE n`,
    );
  });

  describe('createStoryNode', () => {
    test('creates a character node with required fields', async () => {
      const nodeId = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Alice',
          description: 'The protagonist',
        }),
      );

      expect(nodeId).toBeDefined();
      expect(typeof nodeId).toBe('string');

      const node = await graphService.getStoryNodeById(nodeId, testUserId);
      expect(node).not.toBeNull();
      expect(node?.name).toBe('Alice');
      expect(node?.type).toBe('character');
      expect(node?.description).toBe('The protagonist');
      expect(node?.documentId).toBe(testDocumentId);
      expect(node?.userId).toBe(testUserId);
    });

    test('creates nodes with different types', async () => {
      const types = ['character', 'location', 'event', 'concept'] as const;

      for (const type of types) {
        const nodeId = await graphService.createStoryNode(
          testDocumentId,
          testUserId,
          createNodeInput({
            type,
            name: `Test ${type}`,
          }),
        );

        const node = await graphService.getStoryNodeById(nodeId, testUserId);
        expect(node?.type).toBe(type);
      }
    });

    test('creates node with aliases', async () => {
      const nodeId = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Bob',
          aliases: ['Robert', 'Bobby'],
        }),
      );

      const node = await graphService.getStoryNodeById(nodeId, testUserId);
      expect(node?.aliases).toEqual(['Robert', 'Bobby']);
    });

    test('creates node with style options', async () => {
      const nodeId = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Styled Character',
        }),
        {
          stylePreset: 'anime',
          stylePrompt: 'detailed shading',
        },
      );

      const node = await graphService.getStoryNodeById(nodeId, testUserId);
      expect(node?.stylePreset).toBe('anime');
      expect(node?.stylePrompt).toBe('detailed shading');
    });

    test('creates node with documentOrder', async () => {
      const nodeId = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'event',
          name: 'First Event',
          documentOrder: 1,
        }),
      );

      const node = await graphService.getStoryNodeById(nodeId, testUserId);
      expect(node?.documentOrder).toBe(1);
    });
  });

  describe('getStoryNodeById', () => {
    test('returns null for non-existent node', async () => {
      const node = await graphService.getStoryNodeById(
        'non-existent-id',
        testUserId,
      );
      expect(node).toBeNull();
    });

    test('returns null when userId does not match', async () => {
      const nodeId = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Private Node',
        }),
      );

      const node = await graphService.getStoryNodeById(
        nodeId,
        'different-user',
      );
      expect(node).toBeNull();
    });

    test('returns null for soft-deleted node', async () => {
      const nodeId = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Deleted Node',
        }),
      );

      await graphService.softDeleteStoryNode(nodeId);

      const node = await graphService.getStoryNodeById(nodeId, testUserId);
      expect(node).toBeNull();
    });
  });

  describe('getStoryNodesForDocument', () => {
    test('returns empty array for document with no nodes', async () => {
      const nodes = await graphService.getStoryNodesForDocument(
        'empty-doc',
        testUserId,
      );
      expect(nodes).toEqual([]);
    });

    test('returns all nodes for a document', async () => {
      await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Node 1',
        }),
      );
      await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'location',
          name: 'Node 2',
        }),
      );

      const nodes = await graphService.getStoryNodesForDocument(
        testDocumentId,
        testUserId,
      );
      expect(nodes).toHaveLength(2);
      expect(nodes.map((n) => n.name).sort()).toEqual(['Node 1', 'Node 2']);
    });

    test('excludes soft-deleted nodes', async () => {
      await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Active Node',
        }),
      );
      const nodeId2 = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Deleted Node',
        }),
      );

      await graphService.softDeleteStoryNode(nodeId2);

      const nodes = await graphService.getStoryNodesForDocument(
        testDocumentId,
        testUserId,
      );
      expect(nodes).toHaveLength(1);
      expect(nodes[0].name).toBe('Active Node');
    });

    test('excludes nodes from other users', async () => {
      await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'My Node',
        }),
      );
      await graphService.createStoryNode(
        testDocumentId,
        'other-user',
        createNodeInput({
          type: 'character',
          name: 'Other Node',
        }),
      );

      const nodes = await graphService.getStoryNodesForDocument(
        testDocumentId,
        testUserId,
      );
      expect(nodes).toHaveLength(1);
      expect(nodes[0].name).toBe('My Node');
    });
  });

  describe('updateStoryNode', () => {
    test('updates node name', async () => {
      const nodeId = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Original Name',
        }),
      );

      await graphService.updateStoryNode(nodeId, { name: 'Updated Name' });

      const node = await graphService.getStoryNodeById(nodeId, testUserId);
      expect(node?.name).toBe('Updated Name');
    });

    test('updates node description', async () => {
      const nodeId = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Test',
          description: 'Original description',
        }),
      );

      await graphService.updateStoryNode(nodeId, {
        description: 'New description',
      });

      const node = await graphService.getStoryNodeById(nodeId, testUserId);
      expect(node?.description).toBe('New description');
    });

    test('updates node aliases', async () => {
      const nodeId = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Test',
          aliases: ['Old Alias'],
        }),
      );

      await graphService.updateStoryNode(nodeId, {
        aliases: ['New Alias 1', 'New Alias 2'],
      });

      const node = await graphService.getStoryNodeById(nodeId, testUserId);
      expect(node?.aliases).toEqual(['New Alias 1', 'New Alias 2']);
    });

    test('updates documentOrder', async () => {
      const nodeId = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'event',
          name: 'Event',
          documentOrder: 1,
        }),
      );

      await graphService.updateStoryNode(nodeId, { documentOrder: 5 });

      const node = await graphService.getStoryNodeById(nodeId, testUserId);
      expect(node?.documentOrder).toBe(5);
    });

    test('updates updatedAt timestamp', async () => {
      const nodeId = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Test',
        }),
      );

      const before = await graphService.getStoryNodeById(nodeId, testUserId);
      const beforeUpdatedAt = before?.updatedAt;

      await new Promise((r) => setTimeout(r, 10));
      await graphService.updateStoryNode(nodeId, { name: 'Changed' });

      const after = await graphService.getStoryNodeById(nodeId, testUserId);
      expect(after?.updatedAt).not.toBe(beforeUpdatedAt);
    });
  });

  describe('updateStoryNodeStyle', () => {
    test('updates stylePreset and stylePrompt', async () => {
      const nodeId = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Styleable',
        }),
      );

      const updated = await graphService.updateStoryNodeStyle(
        nodeId,
        'realistic',
        'high detail',
      );

      expect(updated).not.toBeNull();
      expect(updated?.stylePreset).toBe('realistic');
      expect(updated?.stylePrompt).toBe('high detail');
    });

    test('clears style when set to null', async () => {
      const nodeId = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Styleable',
        }),
        { stylePreset: 'anime', stylePrompt: 'detailed' },
      );

      const updated = await graphService.updateStoryNodeStyle(
        nodeId,
        null,
        null,
      );

      expect(updated?.stylePreset).toBeNull();
      expect(updated?.stylePrompt).toBeNull();
    });

    test('returns null for non-existent node', async () => {
      const result = await graphService.updateStoryNodeStyle(
        'non-existent',
        'anime',
        'prompt',
      );
      expect(result).toBeNull();
    });
  });

  describe('updateStoryNodePrimaryMedia', () => {
    test('sets primaryMediaId', async () => {
      const nodeId = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'With Media',
        }),
      );

      await graphService.updateStoryNodePrimaryMedia(nodeId, 'media-123');

      const node = await graphService.getStoryNodeById(nodeId, testUserId);
      expect(node?.primaryMediaId).toBe('media-123');
    });

    test('clears primaryMediaId when set to null', async () => {
      const nodeId = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'With Media',
        }),
      );

      await graphService.updateStoryNodePrimaryMedia(nodeId, 'media-123');
      await graphService.updateStoryNodePrimaryMedia(nodeId, null);

      const node = await graphService.getStoryNodeById(nodeId, testUserId);
      expect(node?.primaryMediaId).toBeNull();
    });
  });

  describe('softDeleteStoryNode', () => {
    test('marks node as deleted', async () => {
      const nodeId = await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'To Delete',
        }),
      );

      await graphService.softDeleteStoryNode(nodeId);

      const node = await graphService.getStoryNodeById(nodeId, testUserId);
      expect(node).toBeNull();

      const internalNode = await graphService.getStoryNodeByIdInternal(nodeId);
      expect(internalNode).toBeNull();
    });
  });

  describe('deleteAllStoryNodesForDocument', () => {
    test('removes all nodes for a document', async () => {
      await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Node 1',
        }),
      );
      await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'location',
          name: 'Node 2',
        }),
      );

      await graphService.deleteAllStoryNodesForDocument(
        testDocumentId,
        testUserId,
      );

      const nodes = await graphService.getStoryNodesForDocument(
        testDocumentId,
        testUserId,
      );
      expect(nodes).toEqual([]);
    });

    test('does not delete nodes from other documents', async () => {
      await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Target Doc Node',
        }),
      );
      await graphService.createStoryNode(
        'other-doc',
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'Other Doc Node',
        }),
      );

      await graphService.deleteAllStoryNodesForDocument(
        testDocumentId,
        testUserId,
      );

      const otherNodes = await graphService.getStoryNodesForDocument(
        'other-doc',
        testUserId,
      );
      expect(otherNodes).toHaveLength(1);
      expect(otherNodes[0].name).toBe('Other Doc Node');
    });

    test('does not delete nodes from other users', async () => {
      await graphService.createStoryNode(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'character',
          name: 'My Node',
        }),
      );
      await graphService.createStoryNode(
        testDocumentId,
        'other-user',
        createNodeInput({
          type: 'character',
          name: 'Other User Node',
        }),
      );

      await graphService.deleteAllStoryNodesForDocument(
        testDocumentId,
        testUserId,
      );

      const otherNodes = await graphService.getStoryNodesForDocument(
        testDocumentId,
        'other-user',
      );
      expect(otherNodes).toHaveLength(1);
      expect(otherNodes[0].name).toBe('Other User Node');
    });
  });
});
