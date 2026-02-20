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

(isFalkorDBAvailable ? describe : describe.skip)(
  'Graph: Query Operations',
  () => {
    // Unique IDs for this test file - enables parallel execution with other graph test files
    const testUserId = 'graph-test-queries';
    const testDocumentId = 'graph-test-queries-doc';

    beforeAll(async () => {
      await graphService.connect();
      await graphService.initializeIndexes();
    });

    afterAll(async () => {
      // Clean up this test file's data before disconnecting
      await graphService.query(
        `MATCH (n {userId: '${testUserId}'}) DETACH DELETE n`,
      );
      await graphService.disconnect();
    });

    beforeEach(async () => {
      // Only clear this test file's nodes - allows parallel execution
      await graphService.query(
        `MATCH (n {userId: '${testUserId}'}) DETACH DELETE n`,
      );
    });

    describe('query (raw Cypher)', () => {
      test('executes simple query', async () => {
        const result = await graphService.query('RETURN 1 as value');
        expect(result.data).toHaveLength(1);
        expect(result.data[0][0]).toBe(1);
      });

      test('executes query with parameters', async () => {
        const result = await graphService.query('RETURN $value as value', {
          value: 42,
        });
        expect(result.data[0][0]).toBe(42);
      });

      test('returns stats object', async () => {
        await graphService.createStoryNode(
          testDocumentId,
          testUserId,
          createNodeInput({
            type: 'character',
            name: 'Test',
          }),
        );

        const result = await graphService.query('MATCH (n) RETURN count(n)');
        expect(result.stats).toBeDefined();
      });

      test('returns headers for named columns', async () => {
        const result = await graphService.query('RETURN 1 as foo, 2 as bar');
        expect(result.headers).toContain('foo');
        expect(result.headers).toContain('bar');
      });
    });

    describe('createNode (low-level)', () => {
      test('creates node with properties', async () => {
        const internalId = await graphService.createNode('StoryNode', {
          id: 'custom-id-1',
          name: 'Test Node',
          type: 'character',
          documentId: testDocumentId,
          userId: testUserId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deletedAt: null,
        });

        expect(internalId).toBeDefined();
        expect(typeof internalId).toBe('string');
      });

      test('throws for invalid label', async () => {
        await expect(
          graphService.createNode('InvalidLabel', {
            id: 'test',
            name: 'Test',
          }),
        ).rejects.toThrow('Invalid node label');
      });
    });

    describe('findNodes', () => {
      test('finds nodes by label', async () => {
        await graphService.createStoryNode(testDocumentId, testUserId, {
          type: 'character',
          name: 'Char 1',
          description: null,
        });
        await graphService.createStoryNode(testDocumentId, testUserId, {
          type: 'location',
          name: 'Loc 1',
          description: null,
        });

        const result = await graphService.findNodes('Character');
        expect(result.data.length).toBeGreaterThanOrEqual(1);
      });

      test('finds nodes with property filter', async () => {
        await graphService.createStoryNode(testDocumentId, testUserId, {
          type: 'character',
          name: 'Alice',
          description: null,
        });
        await graphService.createStoryNode(testDocumentId, testUserId, {
          type: 'character',
          name: 'Bob',
          description: null,
        });

        const result = await graphService.findNodes('Character', {
          name: 'Alice',
        });
        expect(result.data).toHaveLength(1);
      });
    });

    describe('connection status', () => {
      test('reports connection status as true when connected', () => {
        const status = graphService.getConnectionStatus();
        expect(status).toBe(true);
      });
    });

    describe('explainQuery', () => {
      test('returns execution plan for query', async () => {
        await graphService.createStoryNode(
          testDocumentId,
          testUserId,
          createNodeInput({
            type: 'character',
            name: 'Test',
          }),
        );

        const plan = await graphService.explainQuery(
          'MATCH (n:StoryNode) WHERE n.documentId = $docId RETURN n',
          { docId: testDocumentId },
        );

        expect(plan).toBeDefined();
        expect(typeof plan).toBe('string');
        expect(plan.length).toBeGreaterThan(0);
      });
    });

    describe('input validation', () => {
      test('rejects invalid internal ID', async () => {
        await expect(
          graphService.updateNode('not-a-number', { name: 'test' }),
        ).rejects.toThrow('Invalid internal node/edge ID');
      });

      test('rejects negative internal ID', async () => {
        await expect(
          graphService.updateNode('-1', { name: 'test' }),
        ).rejects.toThrow('Invalid internal node/edge ID');
      });

      test('rejects invalid property name', async () => {
        const internalId = await graphService.createNode('StoryNode', {
          id: 'test-id',
          name: 'Test',
          type: 'character',
          documentId: testDocumentId,
          userId: testUserId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deletedAt: null,
        });

        await expect(
          graphService.updateNode(internalId, { invalidProp: 'value' } as any),
        ).rejects.toThrow('Invalid property name');
      });
    });

    describe('cleanupSoftDeleted', () => {
      test('removes old soft-deleted nodes and connections', async () => {
        const node1 = await graphService.createStoryNode(
          testDocumentId,
          testUserId,
          createNodeInput({
            type: 'character',
            name: 'Old Deleted',
          }),
        );
        await graphService.createStoryNode(
          testDocumentId,
          testUserId,
          createNodeInput({
            type: 'character',
            name: 'Active',
          }),
        );

        await graphService.softDeleteStoryNode(node1);

        const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24);
        const result = await graphService.cleanupSoftDeleted(futureDate);

        expect(result.nodes).toBe(1);

        const remainingNodes = await graphService.getStoryNodesForDocument(
          testDocumentId,
          testUserId,
        );
        expect(remainingNodes).toHaveLength(1);
        expect(remainingNodes[0].name).toBe('Active');
      });

      test('does not remove recently deleted nodes', async () => {
        const node = await graphService.createStoryNode(
          testDocumentId,
          testUserId,
          createNodeInput({
            type: 'character',
            name: 'Recently Deleted',
          }),
        );

        await graphService.softDeleteStoryNode(node);

        const pastDate = new Date(Date.now() - 1000 * 60 * 60);
        const result = await graphService.cleanupSoftDeleted(pastDate);

        expect(result.nodes).toBe(0);
      });
    });

    describe('narrative threads', () => {
      test('creates narrative thread', async () => {
        const threadId = await graphService.createNarrativeThread(
          testDocumentId,
          testUserId,
          {
            name: 'Main Plot',
            isPrimary: true,
            eventNames: [],
          },
        );

        expect(threadId).toBeDefined();
        expect(typeof threadId).toBe('string');
      });

      test('links event to thread', async () => {
        const eventId = await graphService.createStoryNode(
          testDocumentId,
          testUserId,
          createNodeInput({
            type: 'event',
            name: 'Key Event',
          }),
        );

        const threadId = await graphService.createNarrativeThread(
          testDocumentId,
          testUserId,
          {
            name: 'Main Plot',
            isPrimary: true,
            eventNames: [],
          },
        );

        await graphService.linkEventToThread(eventId, threadId, 0);

        const result = await graphService.query(
          `
        MATCH (e:StoryNode)-[r:BELONGS_TO_THREAD]->(nt:NarrativeThread)
        WHERE e.id = $eventId AND nt.id = $threadId
        RETURN r.order as order
        `,
          { eventId, threadId },
        );

        expect(result.data).toHaveLength(1);
        expect(result.data[0][0]).toBe(0);
      });
    });

    describe('index initialization', () => {
      test('createPropertyIndexes completes without error', async () => {
        await graphService.createPropertyIndexes();
      });

      test('createVectorIndex completes without error', async () => {
        await graphService.createVectorIndex();
      });

      test('initializeIndexes completes without error', async () => {
        await graphService.initializeIndexes();
      });
    });
  },
);
