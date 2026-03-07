#!/usr/bin/env bun
import { db } from '../src/config/database';
import { documents } from '../src/models/schema';
import { eq } from 'drizzle-orm';

const DOCUMENT_ID = '60f5dc8e-73f8-4fdb-a085-6ebcd77eb3e0'; // Pearl document from logs

async function checkDocumentContent() {
  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, DOCUMENT_ID))
    .limit(1);

  if (!doc) {
    console.error('Document not found');
    process.exit(1);
  }

  console.log('\n=== DOCUMENT INFO ===');
  console.log('ID:', doc.id);
  console.log('Title:', doc.title);
  console.log('Content length (text):', doc.content?.length || 0);

  if (doc.contentJson && typeof doc.contentJson === 'object') {
    const contentJson = doc.contentJson as any;
    console.log('\n=== CONTENT JSON ===');
    console.log('Type:', contentJson.type);
    console.log('Content array length:', contentJson.content?.length || 0);

    if (contentJson.content && Array.isArray(contentJson.content)) {
      let totalParagraphs = 0;
      let totalTextLength = 0;

      function countNodes(nodes: any[]): void {
        for (const node of nodes) {
          if (node.type === 'paragraph') {
            totalParagraphs++;
          }
          if (node.content && Array.isArray(node.content)) {
            for (const child of node.content) {
              if (child.type === 'text' && child.text) {
                totalTextLength += child.text.length;
              }
            }
            countNodes(node.content);
          }
        }
      }

      countNodes(contentJson.content);

      console.log('Total paragraphs:', totalParagraphs);
      console.log('Total text length in contentJson:', totalTextLength);
      console.log('\nFirst 5 nodes:');
      contentJson.content.slice(0, 5).forEach((node: any, i: number) => {
        console.log(`  ${i + 1}. ${node.type}${node.content ? ` (${node.content.length} children)` : ''}`);
      });
      console.log('\nLast 5 nodes:');
      contentJson.content.slice(-5).forEach((node: any, i: number) => {
        console.log(`  ${contentJson.content.length - 5 + i + 1}. ${node.type}${node.content ? ` (${node.content.length} children)` : ''}`);
      });
    }
  } else {
    console.log('\n⚠️  NO CONTENT JSON FOUND');
  }

  await db.$client.end();
}

checkDocumentContent().catch(console.error);
