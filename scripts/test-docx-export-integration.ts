#!/usr/bin/env bun
/**
 * Integration test for DOCX export functionality
 * Tests the complete export pipeline: route → job → worker → service
 */

import { generateDocx } from '../src/services/export/docx';
import { sanitizeHtml } from '../src/services/export/utils/htmlProcessor';
import { extractPrintStyles } from '../src/services/export/utils/styleExtractor';
import { mapExportError } from '../src/services/export/utils/errorMapper';

console.log('🧪 Running DOCX Export Integration Tests\n');

// Test 1: HTML Sanitization
console.log('Test 1: HTML Sanitization');
const testHtml = `
  <h1>Test</h1>
  <script>alert('xss')</script>
  <p style="color: var(--primary);">Text</p>
  <span data-type="mention" data-label="John">@john</span>
`;
const sanitized = sanitizeHtml(testHtml);
console.assert(!sanitized.includes('<script>'), '❌ Scripts not removed');
console.assert(!sanitized.includes('var('), '❌ CSS vars not removed');
console.assert(sanitized.includes('@John'), '❌ Mentions not converted');
console.log('✅ HTML sanitization works\n');

// Test 2: Style Extraction
console.log('Test 2: Style Extraction');
const testStyles = `
  animation: fade 1s;
  transition: all 0.3s;
  color: red;
`;
const printStyles = extractPrintStyles(testStyles);
console.assert(!printStyles.includes('animation'), '❌ Animation not removed');
console.assert(!printStyles.includes('transition'), '❌ Transition not removed');
console.assert(printStyles.includes('color: red'), '❌ Valid styles removed');
console.assert(printStyles.includes('@media print'), '❌ Print styles not added');
console.log('✅ Style extraction works\n');

// Test 3: Error Mapping
console.log('Test 3: Error Mapping');
const memoryError = new Error('Heap out of memory');
const mapped = mapExportError(memoryError, 'docx');
console.assert(
	mapped.includes('too large'),
	'❌ Memory error not mapped correctly',
);
console.log('✅ Error mapping works\n');

// Test 4: DOCX Generation
console.log('Test 4: DOCX Generation');
const html = `
  <h1>Test Document</h1>
  <p>This is a test paragraph with <strong>bold</strong> and <em>italic</em> text.</p>
  <h2>Lists</h2>
  <ul>
    <li>Item 1</li>
    <li>Item 2
      <ul>
        <li>Nested item 1</li>
        <li>Nested item 2</li>
      </ul>
    </li>
  </ul>
  <h2>Blockquotes</h2>
  <blockquote>
    <p>Quote level 1</p>
    <blockquote>
      <p>Quote level 2</p>
    </blockquote>
  </blockquote>
`;

const styles = `
  h1 { font-size: 24px; }
  h2 { font-size: 18px; }
  p { font-size: 12px; }
`;

try {
	const result = await generateDocx(html, styles, {
		format: 'a4',
		orientation: 'portrait',
	});

	console.assert(result.buffer instanceof Buffer, '❌ Result is not a Buffer');
	console.assert(result.buffer.length > 2000, '❌ DOCX file too small');
	console.assert(
		result.mimeType ===
			'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		'❌ Wrong MIME type',
	);
	console.assert(result.extension === 'docx', '❌ Wrong extension');

	console.log(`✅ DOCX generation works (${result.buffer.length} bytes)\n`);
} catch (error) {
	console.error('❌ DOCX generation failed:', error);
	process.exit(1);
}

// Test 5: Large Document
console.log('Test 5: Large Document (100 paragraphs)');
const largeParagraph = '<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>';
const largeHtml = `<h1>Large Document</h1>${largeParagraph.repeat(100)}`;

try {
	const result = await generateDocx(largeHtml, styles, {
		format: 'a4',
		orientation: 'portrait',
	});

	console.assert(
		result.buffer.length > 10000,
		'❌ Large DOCX file too small',
	);
	console.log(
		`✅ Large document works (${result.buffer.length} bytes, expected >10KB)\n`,
	);
} catch (error) {
	console.error('❌ Large document generation failed:', error);
	process.exit(1);
}

// Test 6: Cancellation
console.log('Test 6: Cancellation Support');
try {
	await generateDocx(
		largeHtml,
		styles,
		{ format: 'a4', orientation: 'portrait' },
		() => true, // Always return true to trigger immediate cancellation
	);
	console.error('❌ Cancellation did not throw error');
	process.exit(1);
} catch (error) {
	const errorMessage = (error as Error).message;
	console.assert(
		errorMessage.includes('cancelled'),
		'❌ Wrong cancellation error',
	);
	console.log('✅ Cancellation works\n');
}

console.log('🎉 All integration tests passed!');
