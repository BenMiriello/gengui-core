import type { ExportFormat } from '../types';

export function mapExportError(error: Error, format: ExportFormat): string {
  const message = error.message.toLowerCase();

  // Size limits
  if (message.includes('memory') || message.includes('heap')) {
    return `Document too large for ${format.toUpperCase()} export. Try splitting into smaller documents.`;
  }

  // Timeout
  if (message.includes('timeout') || message.includes('timed out')) {
    return 'Export took too long. Try a smaller document or contact support.';
  }

  // Format-specific errors
  if (format === 'pdf') {
    if (message.includes('browser') || message.includes('puppeteer')) {
      return 'PDF generation failed. Please try again.';
    }
  }

  if (format === 'docx') {
    if (message.includes('invalid html') || message.includes('parse')) {
      return 'Document contains unsupported formatting. Please simplify and try again.';
    }
  }

  // Generic fallback
  return `Failed to generate ${format.toUpperCase()}. Please try again or contact support.`;
}
