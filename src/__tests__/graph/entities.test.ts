import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { GraphService } from '../../services/graph/graph.service';
import type { EntityResult } from '../../types/entities';

// Skip if FalkorDB is not available (detected in preload.ts)
const isFalkorDBAvailable = process.env.FALKORDB_AVAILABLE === 'true';

// Create our own instance to bypass any mocks applied to the singleton
const graphService = new GraphService();

function createNodeInput(
  overrides: Partial<EntityResult> & {
    type: EntityResult['type'];
    name: string;
  },
): EntityResult {
  return {
    description: '',
    mentions: [],
    ...overrides,
  };
}

(isFalkorDBAvailable ? describe : describe.skip)('Graph: Entities', () => {
  // Unique IDs for this test file - enables parallel execution with other graph test files
  const testUserId = '00000000-0000-0000-0000-000000000001';
  const testDocumentId = '00000000-0000-0000-0000-000000000002';

  beforeAll(async () => {
    await graphService.connect();
    await graphService.initializeIndexes();
  });

  const otherUserId = '00000000-0000-0000-0000-000000000003';
  const differentUserId = '00000000-0000-0000-0000-000000000004';
  const emptyDocId = '00000000-0000-0000-0000-000000000005';
  const otherDocId = '00000000-0000-0000-0000-000000000006';

  afterAll(async () => {
    // Clean up all test nodes (including test-specific otherUserId nodes)
    await graphService.query(
      `MATCH (n) WHERE n.userId IN ['${testUserId}', '${otherUserId}', '${differentUserId}'] DETACH DELETE n`,
    );
    await graphService.disconnect();
  });

  beforeEach(async () => {
    // Clean up all test nodes before each test
    await graphService.query(
      `MATCH (n) WHERE n.userId IN ['${testUserId}', '${otherUserId}', '${differentUserId}'] DETACH DELETE n`,
    );
  });

  describe('createEntity', () => {
    test('creates a character node with required fields', async () => {
      const nodeId = await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'person',
          name: 'Alice',
          description: 'The protagonist',
        }),
      );

      expect(nodeId).toBeDefined();
      expect(typeof nodeId).toBe('string');

      const node = await graphService.getEntityById(nodeId, testUserId);
      expect(node).not.toBeNull();
      expect(node?.name).toBe('Alice');
      expect(node?.type).toBe('person');
      expect(node?.description).toBe('The protagonist');
      expect(node?.documentId).toBe(testDocumentId);
      expect(node?.userId).toBe(testUserId);
    });

    test('creates nodes with different types', async () => {
      const types = ['person', 'place', 'event', 'concept'] as const;

      for (const type of types) {
        const nodeId = await graphService.createEntity(
          testDocumentId,
          testUserId,
          createNodeInput({
            type,
            name: `Test ${type}`,
          }),
        );

        const node = await graphService.getEntityById(nodeId, testUserId);
        expect(node?.type).toBe(type);
      }
    });

    test('creates node with aliases', async () => {
      const nodeId = await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'person',
          name: 'Bob',
          aliases: ['Robert', 'Bobby'],
        }),
      );

      const node = await graphService.getEntityById(nodeId, testUserId);
      expect(node?.aliases).toEqual(['Robert', 'Bobby']);
    });

    test('creates node with style options', async () => {
      const nodeId = await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'person',
          name: 'Styled Character',
        }),
        {
          stylePreset: 'anime',
          stylePrompt: 'detailed shading',
        },
      );

      const node = await graphService.getEntityById(nodeId, testUserId);
      expect(node?.stylePreset).toBe('anime');
      expect(node?.stylePrompt).toBe('detailed shading');
    });

    test('creates node with documentOrder', async () => {
      const nodeId = await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'event',
          name: 'First Event',
          documentOrder: 1,
        }),
      );

      const node = await graphService.getEntityById(nodeId, testUserId);
      expect(node?.documentOrder).toBe(1);
    });
  });

  describe('getEntityById', () => {
    test('returns null for non-existent node', async () => {
      const node = await graphService.getEntityById(
        'non-existent-id',
        testUserId,
      );
      expect(node).toBeNull();
    });

    test('returns null when userId does not match', async () => {
      const nodeId = await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'person',
          name: 'Private Node',
        }),
      );

      const node = await graphService.getEntityById(nodeId, differentUserId);
      expect(node).toBeNull();
    });

    test('returns null for soft-deleted node', async () => {
      const nodeId = await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'person',
          name: 'Deleted Node',
        }),
      );

      await graphService.softDeleteEntity(nodeId);

      const node = await graphService.getEntityById(nodeId, testUserId);
      expect(node).toBeNull();
    });
  });

  describe('getEntitiesForDocument', () => {
    test('returns empty array for document with no nodes', async () => {
      const nodes = await graphService.getEntitiesForDocument(
        emptyDocId,
        testUserId,
      );
      expect(nodes).toEqual([]);
    });

    test('returns all nodes for a document', async () => {
      await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'person',
          name: 'Node 1',
        }),
      );
      await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'place',
          name: 'Node 2',
        }),
      );

      const nodes = await graphService.getEntitiesForDocument(
        testDocumentId,
        testUserId,
      );
      expect(nodes).toHaveLength(2);
      expect(nodes.map((n) => n.name).sort()).toEqual(['Node 1', 'Node 2']);
    });

    test('excludes soft-deleted nodes', async () => {
      await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'person',
          name: 'Active Node',
        }),
      );
      const nodeId2 = await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'person',
          name: 'Deleted Node',
        }),
      );

      await graphService.softDeleteEntity(nodeId2);

      const nodes = await graphService.getEntitiesForDocument(
        testDocumentId,
        testUserId,
      );
      expect(nodes).toHaveLength(1);
      expect(nodes[0].name).toBe('Active Node');
    });

    test('excludes nodes from other users', async () => {
      await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'person',
          name: 'My Node',
        }),
      );
      await graphService.createEntity(
        testDocumentId,
        otherUserId,
        createNodeInput({
          type: 'person',
          name: 'Other Node',
        }),
      );

      const nodes = await graphService.getEntitiesForDocument(
        testDocumentId,
        testUserId,
      );
      expect(nodes).toHaveLength(1);
      expect(nodes[0].name).toBe('My Node');
    });
  });

  describe('updateEntity', () => {
    test('updates node name', async () => {
      const nodeId = await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'person',
          name: 'Original Name',
        }),
      );

      await graphService.updateEntity(nodeId, { name: 'Updated Name' });

      const node = await graphService.getEntityById(nodeId, testUserId);
      expect(node?.name).toBe('Updated Name');
    });

    test('updates node description', async () => {
      const nodeId = await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'person',
          name: 'Test',
          description: 'Original description',
        }),
      );

      await graphService.updateEntity(nodeId, {
        description: 'New description',
      });

      const node = await graphService.getEntityById(nodeId, testUserId);
      expect(node?.description).toBe('New description');
    });

    test('updates node aliases', async () => {
      const nodeId = await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'person',
          name: 'Test',
          aliases: ['Old Alias'],
        }),
      );

      await graphService.updateEntity(nodeId, {
        aliases: ['New Alias 1', 'New Alias 2'],
      });

      const node = await graphService.getEntityById(nodeId, testUserId);
      expect(node?.aliases).toEqual(['New Alias 1', 'New Alias 2']);
    });

    test('updates documentOrder', async () => {
      const nodeId = await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'event',
          name: 'Event',
          documentOrder: 1,
        }),
      );

      await graphService.updateEntity(nodeId, { documentOrder: 5 });

      const node = await graphService.getEntityById(nodeId, testUserId);
      expect(node?.documentOrder).toBe(5);
    });

    test('updates updatedAt timestamp', async () => {
      const nodeId = await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'person',
          name: 'Test',
        }),
      );

      const before = await graphService.getEntityById(nodeId, testUserId);
      const beforeUpdatedAt = before?.updatedAt;

      await new Promise((r) => setTimeout(r, 10));
      await graphService.updateEntity(nodeId, { name: 'Changed' });

      const after = await graphService.getEntityById(nodeId, testUserId);
      expect(after?.updatedAt).not.toBe(beforeUpdatedAt);
    });
  });

  describe('updateEntityStyle', () => {
    test('updates stylePreset and stylePrompt', async () => {
      const nodeId = await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'person',
          name: 'Styleable',
        }),
      );

      const updated = await graphService.updateEntityStyle(
        nodeId,
        'realistic',
        'high detail',
      );

      expect(updated).not.toBeNull();
      expect(updated?.stylePreset).toBe('realistic');
      expect(updated?.stylePrompt).toBe('high detail');
    });

    test('clears style when set to null', async () => {
      const nodeId = await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'person',
          name: 'Styleable',
        }),
        { stylePreset: 'anime', stylePrompt: 'detailed' },
      );

      const updated = await graphService.updateEntityStyle(nodeId, null, null);

      expect(updated?.stylePreset).toBeNull();
      expect(updated?.stylePrompt).toBeNull();
    });

    test('returns null for non-existent node', async () => {
      const result = await graphService.updateEntityStyle(
        'non-existent',
        'anime',
        'prompt',
      );
      expect(result).toBeNull();
    });
  });

  describe('updateEntityPrimaryMedia', () => {
    test('sets primaryMediaId', async () => {
      const nodeId = await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'person',
          name: 'With Media',
        }),
      );

      await graphService.updateEntityPrimaryMedia(nodeId, 'media-123');

      const node = await graphService.getEntityById(nodeId, testUserId);
      expect(node?.primaryMediaId).toBe('media-123');
    });

    test('clears primaryMediaId when set to null', async () => {
      const nodeId = await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'person',
          name: 'With Media',
        }),
      );

      await graphService.updateEntityPrimaryMedia(nodeId, 'media-123');
      await graphService.updateEntityPrimaryMedia(nodeId, null);

      const node = await graphService.getEntityById(nodeId, testUserId);
      expect(node?.primaryMediaId).toBeNull();
    });
  });

  describe('softDeleteEntity', () => {
    test('marks node as deleted', async () => {
      const nodeId = await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'person',
          name: 'To Delete',
        }),
      );

      await graphService.softDeleteEntity(nodeId);

      const node = await graphService.getEntityById(nodeId, testUserId);
      expect(node).toBeNull();

      const internalNode = await graphService.getEntityByIdInternal(nodeId);
      expect(internalNode).toBeNull();
    });
  });

  describe('deleteAllEntitiesForDocument', () => {
    test('removes all nodes for a document', async () => {
      await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'person',
          name: 'Node 1',
        }),
      );
      await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'place',
          name: 'Node 2',
        }),
      );

      await graphService.deleteAllEntitiesForDocument(
        testDocumentId,
        testUserId,
      );

      const nodes = await graphService.getEntitiesForDocument(
        testDocumentId,
        testUserId,
      );
      expect(nodes).toEqual([]);
    });

    test('does not delete nodes from other documents', async () => {
      await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'person',
          name: 'Target Doc Node',
        }),
      );
      await graphService.createEntity(
        otherDocId,
        testUserId,
        createNodeInput({
          type: 'person',
          name: 'Other Doc Node',
        }),
      );

      await graphService.deleteAllEntitiesForDocument(
        testDocumentId,
        testUserId,
      );

      const otherNodes = await graphService.getEntitiesForDocument(
        otherDocId,
        testUserId,
      );
      expect(otherNodes).toHaveLength(1);
      expect(otherNodes[0].name).toBe('Other Doc Node');
    });

    test('does not delete nodes from other users', async () => {
      await graphService.createEntity(
        testDocumentId,
        testUserId,
        createNodeInput({
          type: 'person',
          name: 'My Node',
        }),
      );
      await graphService.createEntity(
        testDocumentId,
        otherUserId,
        createNodeInput({
          type: 'person',
          name: 'Other User Node',
        }),
      );

      await graphService.deleteAllEntitiesForDocument(
        testDocumentId,
        testUserId,
      );

      const otherNodes = await graphService.getEntitiesForDocument(
        testDocumentId,
        otherUserId,
      );
      expect(otherNodes).toHaveLength(1);
      expect(otherNodes[0].name).toBe('Other User Node');
    });
  });
});
