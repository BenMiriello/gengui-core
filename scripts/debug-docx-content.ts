#!/usr/bin/env bun
/**
 * Debug script to test DOCX content rendering
 */

import { writeFileSync } from 'fs';
import { generateDocx } from '../src/services/export/docx';

console.log('🔍 Debugging DOCX Content Generation\n');

// Test 1: Minimal HTML (no wrapper)
console.log('Test 1: Minimal HTML (no wrapper)');
try {
	const minimalHtml = '<p>Hello World</p>';
	const result = await generateDocx(minimalHtml, '', {
		format: 'a4',
		orientation: 'portrait',
	});
	writeFileSync('/tmp/test-minimal.docx', result.buffer);
	console.log(`✅ Generated /tmp/test-minimal.docx (${result.buffer.length} bytes)`);
} catch (error) {
	console.error('❌ Failed:', error);
}

// Test 2: Simple formatted text (no wrapper)
console.log('\nTest 2: Simple formatted text (no wrapper)');
try {
	const simpleHtml = `
		<h1>Test Document</h1>
		<p>This is a <strong>bold</strong> and <em>italic</em> test.</p>
		<ul>
			<li>Item 1</li>
			<li>Item 2</li>
		</ul>
	`;
	const result = await generateDocx(simpleHtml, '', {
		format: 'a4',
		orientation: 'portrait',
	});
	writeFileSync('/tmp/test-simple.docx', result.buffer);
	console.log(`✅ Generated /tmp/test-simple.docx (${result.buffer.length} bytes)`);
} catch (error) {
	console.error('❌ Failed:', error);
}

// Test 3: With full document wrapper
console.log('\nTest 3: With full document wrapper');
try {
	const wrappedHtml = `
		<!DOCTYPE html>
		<html>
			<head>
				<meta charset="UTF-8">
				<title>Test</title>
			</head>
			<body>
				<h1>Test Document</h1>
				<p>This is a test paragraph.</p>
			</body>
		</html>
	`;
	const result = await generateDocx(wrappedHtml, '', {
		format: 'a4',
		orientation: 'portrait',
	});
	writeFileSync('/tmp/test-wrapped.docx', result.buffer);
	console.log(`✅ Generated /tmp/test-wrapped.docx (${result.buffer.length} bytes)`);
} catch (error) {
	console.error('❌ Failed:', error);
}

// Test 4: What our actual exporter sends
console.log('\nTest 4: Simulating actual export');
try {
	const editorHtml = '<p>Test paragraph from editor</p><p>Another paragraph</p>';
	const html = `<div class="editor-content">${editorHtml}</div>`;

	// Simulate wrapDocument
	const styles = `
		.editor-content {
			font-family: Arial;
			font-size: 12pt;
		}
		p {
			margin: 0 0 1em 0;
		}
	`;

	const fullHtml = `
		<!DOCTYPE html>
		<html>
			<head>
				<meta charset="UTF-8">
				<title>Document</title>
				<style>${styles}</style>
			</head>
			<body>
				${html}
			</body>
		</html>
	`;

	const result = await generateDocx(fullHtml, '', {
		format: 'a4',
		orientation: 'portrait',
	});
	writeFileSync('/tmp/test-actual-export.docx', result.buffer);
	console.log(`✅ Generated /tmp/test-actual-export.docx (${result.buffer.length} bytes)`);
} catch (error) {
	console.error('❌ Failed:', error);
}

// Test 5: Direct html-docx-js call (bypass our wrapper)
console.log('\nTest 5: Direct html-docx-js call');
try {
	// @ts-ignore
	const htmlDocxJs = await import('html-docx-js');
	const simpleHtml = '<h1>Direct Call Test</h1><p>This bypasses our wrapper function.</p>';

	// @ts-ignore
	const blob = await htmlDocxJs.asBlob(simpleHtml, {
		orientation: 'portrait',
		margins: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
	});

	const arrayBuffer = await blob.arrayBuffer();
	const buffer = Buffer.from(arrayBuffer);
	writeFileSync('/tmp/test-direct.docx', buffer);
	console.log(`✅ Generated /tmp/test-direct.docx (${buffer.length} bytes)`);
} catch (error) {
	console.error('❌ Failed:', error);
}

console.log('\n📁 Test files saved to /tmp/');
console.log('Open them to see which ones render correctly.\n');
