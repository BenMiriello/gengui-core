/**
 * Sanitize HTML for export:
 * - Remove invalid XML control characters (breaks DOCX parsers)
 * - Remove script tags (security)
 * - Remove style attributes with var() (not supported in DOCX/PDF)
 * - Convert data-* attributes to readable text (e.g., mentions)
 */
export function sanitizeHtml(html: string): string {
  // Use regex-based sanitization instead of DOM parsing for broader compatibility
  let sanitized = html;

  // Remove control characters that are invalid in XML 1.0
  // Valid: tab (0x09), newline (0x0A), carriage return (0x0D)
  // Invalid: 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control chars to remove them
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

  // Remove script tags
  sanitized = sanitized.replace(
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
    '',
  );

  // Convert TipTap mentions to readable text
  sanitized = sanitized.replace(
    /<[^>]+data-type="mention"[^>]*data-label="([^"]*)"[^>]*>.*?<\/[^>]+>/g,
    '@$1',
  );
  sanitized = sanitized.replace(
    /<[^>]+data-type="mention"[^>]*>([^<]*)<\/[^>]+>/g,
    '@$1',
  );

  // Remove inline CSS with var()
  sanitized = sanitized.replace(
    /style="([^"]*)"/g,
    (match, styleContent: string) => {
      if (styleContent.includes('var(')) {
        return '';
      }
      return match;
    },
  );

  return sanitized;
}

/**
 * Wrap HTML in document structure with proper charset
 */
export function wrapDocument(
  html: string,
  styles: string,
  title = 'Document',
): string {
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>${title}</title>
        <style>${styles}</style>
      </head>
      <body>
        ${html}
      </body>
    </html>
  `;
}
