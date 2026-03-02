const Redis = require('ioredis');

const client = new Redis('redis://localhost:6381');

async function testQuery() {
  const documentId = 'ce68911c-ebc1-4a13-b493-23026296e2b9';
  const userId = 'd7e37fe5-94e7-49bd-b829-4049798cf93b';

  const cypher = `
    MATCH (n:StoryNode)
    WHERE n.documentId = $documentId AND n.userId = $userId AND n.deletedAt IS NULL
    RETURN n.id, n.name, n.type
  `;

  const query = `CYPHER documentId="${documentId}" userId="${userId}" ${cypher}`;

  console.log('Executing query:', query.substring(0, 150) + '...');

  const result = await client.call('GRAPH.QUERY', 'gengui', query);

  console.log('\nResult:', JSON.stringify(result, null, 2));
  console.log('\nNode count:', result[1] ? result[1].length : 0);

  await client.quit();
}

testQuery().catch(console.error);
