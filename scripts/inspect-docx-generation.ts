#!/usr/bin/env bun
/**
 * Inspect what HTML is actually being sent to html-docx-js
 */

import { sanitizeHtml, wrapDocument } from '../src/services/export/utils/htmlProcessor';
import { resolveCssVariables } from '../src/services/export/utils/styleExtractor';

console.log('🔍 Inspecting HTML Processing Pipeline\n');

// Simulate what the exporter does
const editorHtml = '<p>Test paragraph</p><h1>Heading</h1><ul><li>Item 1</li></ul>';
const html = `<div class="editor-content">${editorHtml}</div>`;

console.log('Step 1 - Original HTML from editor:');
console.log(html);
console.log('\n---\n');

const cleanHtml = sanitizeHtml(html);
console.log('Step 2 - After sanitization:');
console.log(cleanHtml);
console.log('\n---\n');

const styles = `
	.editor-content { font-family: Arial; }
	p { margin: 0 0 1em 0; }
`;

const cssVariables = {
	'--color-text-primary': '#333333',
	'--color-accent': '#0066cc',
};

const resolvedStyles = resolveCssVariables(styles, cssVariables);
console.log('Step 3 - Styles with CSS vars resolved:');
console.log(resolvedStyles);
console.log('\n---\n');

const fullHtml = wrapDocument(cleanHtml, resolvedStyles);
console.log('Step 4 - Final HTML sent to html-docx-js:');
console.log(fullHtml);
console.log('\n---\n');

// Now test with simple HTML to confirm html-docx-js works
console.log('Testing html-docx-js with different inputs:\n');

// @ts-ignore
const htmlDocxJs = await import('html-docx-js');

// Test A: Just the content (no wrapper)
console.log('Test A: Raw content (no wrapper)');
try {
	// @ts-ignore
	const blob = await htmlDocxJs.asBlob('<p>Test</p>', {});
	console.log(`✅ Success (${blob.size} bytes)\n`);
} catch (error) {
	console.log(`❌ Failed: ${error}\n`);
}

// Test B: Our wrapped version
console.log('Test B: Our wrapped HTML');
try {
	// @ts-ignore
	const blob = await htmlDocxJs.asBlob(fullHtml, {});
	console.log(`✅ Success (${blob.size} bytes)\n`);
} catch (error) {
	console.log(`❌ Failed: ${error}\n`);
}

// Test C: Check if the issue is with the wrapper structure
console.log('Test C: Minimal wrapper');
const minimalWrapper = `
<!DOCTYPE html>
<html>
<body>
<p>Test content</p>
</body>
</html>
`;
try {
	// @ts-ignore
	const blob = await htmlDocxJs.asBlob(minimalWrapper, {});
	console.log(`✅ Success (${blob.size} bytes)\n`);
} catch (error) {
	console.log(`❌ Failed: ${error}\n`);
}

// Test D: Check if <style> tags cause issues
console.log('Test D: With <style> tag');
const withStyle = `
<!DOCTYPE html>
<html>
<head>
<style>p { color: red; }</style>
</head>
<body>
<p>Styled content</p>
</body>
</html>
`;
try {
	// @ts-ignore
	const blob = await htmlDocxJs.asBlob(withStyle, {});
	console.log(`✅ Success (${blob.size} bytes)\n`);
} catch (error) {
	console.log(`❌ Failed: ${error}\n`);
}
