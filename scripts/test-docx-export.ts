#!/usr/bin/env bun
/**
 * Test script to verify DOCX export functionality
 */
import { generateDocx } from '../src/services/export/docx';

async function testDocxExport() {
	const html = `
    <h1>Test Document</h1>
    <p>This is a test paragraph.</p>
    <h2>Nested Content</h2>
    <blockquote>
      <p>Quote level 1</p>
      <blockquote>
        <p>Quote level 2</p>
      </blockquote>
    </blockquote>
    <ul>
      <li>Item 1</li>
      <li>Item 2
        <ul>
          <li>Nested item 1</li>
          <li>Nested item 2</li>
        </ul>
      </li>
    </ul>
  `;

	const styles = `
    h1 { font-size: 24px; color: #333; }
    h2 { font-size: 18px; color: #666; }
    p { font-size: 12px; line-height: 1.5; }
    blockquote { border-left: 3px solid #ccc; padding-left: 10px; }
  `;

	try {
		console.log('Generating DOCX...');
		const result = await generateDocx(html, styles, {
			format: 'a4',
			orientation: 'portrait',
		});

		console.log('✅ DOCX generated successfully');
		console.log(`   Size: ${result.buffer.length} bytes`);
		console.log(`   MIME type: ${result.mimeType}`);
		console.log(`   Extension: ${result.extension}`);

		// Verify buffer is substantial
		if (result.buffer.length < 1000) {
			throw new Error('DOCX file too small - likely incomplete');
		}

		console.log('✅ All tests passed');
	} catch (error) {
		console.error('❌ Test failed:', error);
		process.exit(1);
	}
}

testDocxExport();
