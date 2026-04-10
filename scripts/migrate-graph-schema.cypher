// Graph Schema Migration: Story vocabulary -> Entity vocabulary
// Idempotent — safe to re-run. Order matters.
//
// Run each statement separately against FalkorDB (FalkorDB does not support
// multi-statement scripts natively — execute one MATCH/CREATE at a time).

// ---------- Pre-migration: fix Other -> Object ----------
MATCH (n:Other) SET n:Object REMOVE n:Other

// ---------- Node Label Renames ----------
MATCH (n:Character) SET n:Person REMOVE n:Character
MATCH (n:Location) SET n:Place REMOVE n:Location
MATCH (n:CharacterState) SET n:ArcState REMOVE n:CharacterState
MATCH (n:StoryNode) SET n:Entity REMOVE n:StoryNode
MATCH (n:NarrativeThread) SET n:Thread REMOVE n:NarrativeThread

// ---------- Edge Changes ----------
// Reverse BELONGS_TO_THREAD (event->thread) to INCLUDES (thread->event)
MATCH (event)-[r:BELONGS_TO_THREAD]->(thread:Thread) CREATE (thread)-[:INCLUDES {order: r.order, createdAt: r.createdAt}]->(event) DELETE r

// Drop POSSESSES edges
MATCH ()-[r:POSSESSES]->() DELETE r

// ---------- Type Property Value Renames ----------
MATCH (n:Entity) WHERE n.type = 'character' SET n.type = 'person'
MATCH (n:Entity) WHERE n.type = 'location' SET n.type = 'place'
MATCH (n:Entity) WHERE n.type = 'other' SET n.type = 'object'

// ---------- Property Renames ----------
// ArcState and Arc nodes: characterId -> entityId
MATCH (n:ArcState) WHERE n.characterId IS NOT NULL SET n.entityId = n.characterId REMOVE n.characterId
MATCH (n:Arc) WHERE n.characterId IS NOT NULL SET n.entityId = n.characterId REMOVE n.characterId

// ---------- Drop Old Indexes ----------
// Property indexes on StoryNode
DROP INDEX ON :StoryNode(documentId)
DROP INDEX ON :StoryNode(userId)
DROP INDEX ON :StoryNode(deletedAt)

// Vector indexes on StoryNode
DROP VECTOR INDEX ON :StoryNode(embedding_1536)
DROP VECTOR INDEX ON :StoryNode(embedding_1024)

// ---------- Recreate Indexes on Entity ----------
// These will also be created by initializeIndexes() at server startup,
// but included here for standalone migration completeness.
CREATE INDEX FOR (n:Entity) ON (n.documentId)
CREATE INDEX FOR (n:Entity) ON (n.userId)
CREATE INDEX FOR (n:Entity) ON (n.deletedAt)
CREATE VECTOR INDEX FOR (n:Entity) ON (n.embedding_1536) OPTIONS {dimension: 1536, similarityFunction: 'cosine'}
CREATE VECTOR INDEX FOR (n:Entity) ON (n.embedding_1024) OPTIONS {dimension: 1024, similarityFunction: 'cosine'}
