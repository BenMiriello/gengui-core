#!/usr/bin/env bun
import AdmZip from 'adm-zip';
import { readFileSync } from 'fs';
import { s3 } from '../src/services/s3';

const s3Key = process.argv[2];
if (!s3Key) {
  console.error('Usage: bun scripts/verify-docx.ts <s3-key>');
  console.error('Example: bun scripts/verify-docx.ts exports/undefined/abc123/file.docx');
  process.exit(1);
}

console.log('Downloading from S3:', s3Key);
const buffer = await s3.downloadBuffer(s3Key);
const zip = new AdmZip(buffer);
const docXmlEntry = zip.getEntry('word/document.xml');

if (!docXmlEntry) {
  console.error('No word/document.xml found in DOCX');
  process.exit(1);
}

const docXml = docXmlEntry.getData().toString('utf8');

console.log('=== DOCX Analysis ===');
console.log('File size:', buffer.length, 'bytes');
console.log('document.xml size:', docXml.length, 'bytes');

// Count paragraphs
const paragraphs = docXml.match(/<w:p[>\s]/g) || [];
console.log('Paragraph count:', paragraphs.length);

// Check structure
console.log('Has <w:body>:', docXml.includes('<w:body>'));
console.log('Has </w:body>:', docXml.includes('</w:body>'));
console.log('Has <w:sectPr:', docXml.includes('<w:sectPr'));

// Extract all paragraph text content
const textMatches = docXml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
let totalTextLength = 0;
for (const match of textMatches) {
  const text = match.replace(/<[^>]+>/g, '');
  totalTextLength += text.length;
}
console.log('Text run count:', textMatches.length);
console.log('Total text length:', totalTextLength, 'chars');

// Show first 500 chars of actual text
const allText = textMatches.map(m => m.replace(/<[^>]+>/g, '')).join('');
console.log('\n=== First 500 chars of text ===');
console.log(allText.substring(0, 500));

// Show last 500 chars of text
console.log('\n=== Last 500 chars of text ===');
console.log(allText.substring(allText.length - 500));

// Check for any truncation markers or errors
if (docXml.includes('</w:document>')) {
  console.log('\n✓ Document properly closed with </w:document>');
} else {
  console.log('\n✗ WARNING: Document NOT properly closed!');
}

// Check all DOCX components
console.log('\n=== DOCX ZIP Contents ===');
for (const entry of zip.getEntries()) {
  console.log(`  ${entry.entryName}: ${entry.getData().length} bytes`);
}

// Check [Content_Types].xml
const contentTypes = zip.getEntry('[Content_Types].xml');
if (contentTypes) {
  console.log('\n=== [Content_Types].xml ===');
  console.log(contentTypes.getData().toString('utf8'));
}

// Check word/_rels/document.xml.rels
const rels = zip.getEntry('word/_rels/document.xml.rels');
if (rels) {
  console.log('\n=== word/_rels/document.xml.rels ===');
  console.log(rels.getData().toString('utf8'));
}

// Validate XML structure of document.xml
console.log('\n=== XML Validation ===');
const openTags = (docXml.match(/<w:[a-zA-Z]+[>\s]/g) || []).length;
const closeTags = (docXml.match(/<\/w:[a-zA-Z]+>/g) || []).length;
console.log('Open tags (w:*):', openTags);
console.log('Close tags (</w:*>):', closeTags);

// Check for body structure
const bodyStart = docXml.indexOf('<w:body>');
const bodyEnd = docXml.indexOf('</w:body>');
console.log('Body starts at:', bodyStart);
console.log('Body ends at:', bodyEnd);
console.log('Body length:', bodyEnd - bodyStart, 'chars');

// Show body structure (first 2000 chars after <w:body>)
if (bodyStart > 0) {
  console.log('\n=== Body start (first 1000 chars) ===');
  console.log(docXml.substring(bodyStart, bodyStart + 1000));
}

// Find unclosed tags
console.log('\n=== Tag Balance Analysis ===');
const tagStack: string[] = [];
const tagPattern = /<(\/?)w:([a-zA-Z]+)[^>]*>/g;
let match;
let lastUnclosed: string[] = [];

while ((match = tagPattern.exec(docXml)) !== null) {
  const isClose = match[1] === '/';
  const tagName = match[2];

  if (isClose) {
    if (tagStack.length > 0 && tagStack[tagStack.length - 1] === tagName) {
      tagStack.pop();
    } else {
      console.log(`Unexpected close tag </w:${tagName}> at position ${match.index}, stack top: ${tagStack[tagStack.length - 1] || 'empty'}`);
    }
  } else {
    // Self-closing tags don't go on stack
    if (!match[0].endsWith('/>')) {
      tagStack.push(tagName);
    }
  }
}

if (tagStack.length > 0) {
  console.log('\nUnclosed tags remaining:', tagStack);
} else {
  console.log('\nAll tags properly balanced');
}

// Try parsing with DOMParser equivalent
console.log('\n=== XML Parser Validation ===');
try {
  const { parseDocument } = require('htmlparser2');
  const dom = parseDocument(docXml, { xmlMode: true });
  console.log('✓ XML parsed successfully');
  console.log('Root children:', dom.children.length);
} catch (e) {
  console.log('✗ XML parse error:', (e as Error).message);
}

// Check for problematic characters in text
console.log('\n=== Character Analysis ===');
const problematicChars = docXml.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g);
if (problematicChars) {
  console.log('Found problematic control characters:', problematicChars.length);
  // Count by type
  const charCounts: Record<string, number> = {};
  for (const char of problematicChars) {
    const code = char.charCodeAt(0);
    const key = `\\x${code.toString(16).padStart(2, '0')} (${code})`;
    charCounts[key] = (charCounts[key] || 0) + 1;
  }
  console.log('Character breakdown:', charCounts);

  // Show context around first problematic char
  const firstIndex = docXml.search(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
  if (firstIndex > 0) {
    console.log('First occurrence at index:', firstIndex);
    console.log('Context:', JSON.stringify(docXml.substring(Math.max(0, firstIndex - 50), firstIndex + 50)));
  }
} else {
  console.log('No problematic control characters found');
}

// Check the end of the document
console.log('\n=== Document end (last 500 chars) ===');
console.log(docXml.substring(docXml.length - 500));
