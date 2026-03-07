#!/usr/bin/env bun
/**
 * Debug why DOCX exports are truncating content
 */

import { writeFileSync } from 'fs';
import { generateDocxNative } from '../src/services/export/docx-native';
import { sanitizeHtml } from '../src/services/export/utils/htmlProcessor';

console.log('🔍 Debugging DOCX Content Truncation\n');

// Create a LARGE document (simulating 100+ pages)
const largeParagraph = '<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>';

const largeHtml = `
<h1>Large Document Test</h1>
<p>This document should have 200 paragraphs.</p>
${largeParagraph.repeat(200)}
<h2>End Section</h2>
<p>If you see this, all content was processed!</p>
`;

console.log(`Input HTML length: ${largeHtml.length} characters`);
console.log(`Input HTML paragraphs: ${(largeHtml.match(/<p>/g) || []).length}`);

// Step 1: Check sanitization
const sanitized = sanitizeHtml(largeHtml);
console.log(`\nAfter sanitization: ${sanitized.length} characters`);
console.log(`Sanitized paragraphs: ${(sanitized.match(/<p>/g) || []).length}`);

if (sanitized.length < largeHtml.length * 0.9) {
	console.log('⚠️  WARNING: Sanitization removed significant content!');
}

// Step 2: Generate DOCX
try {
	console.log('\nGenerating DOCX...');
	const result = await generateDocxNative(largeHtml, '', {
		format: 'a4',
		orientation: 'portrait',
	});

	writeFileSync('/tmp/test-large-docx.docx', result.buffer);
	console.log(`✅ Generated /tmp/test-large-docx.docx (${result.buffer.length} bytes)`);

	// Analyze file size
	const bytesPerParagraph = result.buffer.length / 200;
	console.log(`\nBytes per paragraph: ${bytesPerParagraph.toFixed(0)}`);

	if (result.buffer.length < 50000) {
		console.log('⚠️  WARNING: File size seems too small for 200 paragraphs!');
		console.log('Expected: >50KB, Got:', (result.buffer.length / 1024).toFixed(1), 'KB');
	}

	// Extract and inspect the DOCX structure
	console.log('\n📦 Inspecting DOCX structure...');
	const { execSync } = require('child_process');

	try {
		const wordCount = execSync(
			'unzip -p /tmp/test-large-docx.docx word/document.xml | grep -o "<w:p>" | wc -l',
			{ encoding: 'utf-8' },
		).trim();
		console.log(`DOCX contains ${wordCount} Word paragraphs (<w:p> tags)`);

		if (Number.parseInt(wordCount) < 180) {
			console.log(
				'⚠️  WARNING: DOCX has fewer paragraphs than input HTML!',
			);
			console.log('Expected: ~202, Got:', wordCount);
		}
	} catch (error) {
		console.log('Could not inspect DOCX structure');
	}
} catch (error) {
	console.error('❌ Failed:', error);
	process.exit(1);
}

console.log('\n🔍 Open /tmp/test-large-docx.docx and check:');
console.log('1. Does it show 200+ paragraphs?');
console.log('2. Can you see "End Section" heading at the bottom?');
console.log('3. Can you see "If you see this, all content was processed!"?');
