#!/usr/bin/env bun
import { writeFileSync } from 'fs';
import { generateDocxNative } from '../src/services/export/docx-native';

console.log('Testing native DOCX generation...\n');

const html = `
<h1>Test Document</h1>
<p>This is a test paragraph with <strong>bold</strong> and <em>italic</em> text.</p>
<h2>Lists</h2>
<ul>
  <li>Item 1</li>
  <li>Item 2</li>
  <li>Item 3</li>
</ul>
<h2>Blockquote</h2>
<blockquote>
  <p>This is a quoted text that should be indented.</p>
</blockquote>
<p>Another paragraph after the quote.</p>
`;

try {
	const result = await generateDocxNative(html, '', {
		format: 'a4',
		orientation: 'portrait',
	});

	writeFileSync('/tmp/test-native.docx', result.buffer);
	console.log(`✅ Generated /tmp/test-native.docx (${result.buffer.length} bytes)`);
	console.log('\nTry opening this file in Preview - it should work now!');
} catch (error) {
	console.error('❌ Failed:', error);
	process.exit(1);
}
