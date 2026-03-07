import type { Page } from 'puppeteer';
import { logger } from '../../utils/logger';
import type {
  CancellationCallback,
  ExportOptions,
  ExportResult,
} from './types';
import { sanitizeHtml, wrapDocument } from './utils/htmlProcessor';
import { extractPrintStyles } from './utils/styleExtractor';

interface PdfGenerationOptions extends ExportOptions {
  timeout?: number;
}

export async function generatePdf(
  page: Page,
  html: string,
  styles: string,
  options: PdfGenerationOptions,
  onCancel?: CancellationCallback,
): Promise<ExportResult> {
  // Sanitize and prepare content
  const cleanHtml = sanitizeHtml(html);
  const printStyles = extractPrintStyles(styles);

  // Add PDF-specific styles
  const pdfStyles = `
		${printStyles}

		html, body {
			width: 100%;
			height: 100%;
			margin: 0;
			padding: 0;
		}

		@media print {
			html, body {
				width: 210mm;
				height: 297mm;
			}
		}
	`;

  const fullHtml = wrapDocument(cleanHtml, pdfStyles);

  // Calculate timeout based on content size
  const baseTimeout = 45000;
  const sizeTimeout = Math.min(15000, Math.floor(html.length / 100000) * 5000);
  const timeout = options.timeout || baseTimeout + sizeTimeout;

  // Check for cancellation
  if (onCancel?.()) {
    throw new Error('Export cancelled');
  }

  // Navigate and wait for content
  await page.setContent(fullHtml, {
    waitUntil: 'load',
    timeout,
  });

  if (onCancel?.()) {
    throw new Error('Export cancelled');
  }

  // Wait for fonts to load
  await page.evaluateHandle('document.fonts.ready');
  await page.waitForFunction('document.readyState === "complete"', {
    timeout: 5000,
  });

  if (onCancel?.()) {
    throw new Error('Export cancelled');
  }

  // Generate PDF
  const pdfBuffer = await page.pdf({
    format: options.format || 'a4',
    landscape: options.orientation === 'landscape',
    margin: options.margins || {
      top: '2.5cm',
      right: '2.5cm',
      bottom: '2.5cm',
      left: '2.5cm',
    },
    printBackground: true,
    preferCSSPageSize: false,
  });

  logger.debug(
    { size: pdfBuffer.length, format: options.format },
    'PDF generated successfully',
  );

  return {
    buffer: Buffer.from(pdfBuffer),
    mimeType: 'application/pdf',
    extension: 'pdf',
  };
}
