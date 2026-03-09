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

/**
 * PDF generation timeout configuration.
 *
 * Base timeout covers browser setup, font loading, and small documents.
 * Additional time scales with content size at ~5s per 100k characters.
 *
 * Examples:
 * - 50k chars: 45s base + 0s = 45s
 * - 200k chars: 45s base + 10s = 55s
 * - 500k chars: 45s base + 15s (capped) = 60s
 */
const PDF_TIMEOUT = {
  BASE_MS: 45_000,
  CHARS_PER_UNIT: 100_000,
  MS_PER_UNIT: 5_000,
  MAX_ADDITIONAL_MS: 15_000,
} as const;

function calculateTimeout(
  htmlLength: number,
  explicitTimeout?: number,
): number {
  if (explicitTimeout) return explicitTimeout;

  const additionalMs = Math.min(
    PDF_TIMEOUT.MAX_ADDITIONAL_MS,
    Math.floor(htmlLength / PDF_TIMEOUT.CHARS_PER_UNIT) *
      PDF_TIMEOUT.MS_PER_UNIT,
  );

  return PDF_TIMEOUT.BASE_MS + additionalMs;
}

export async function generatePdf(
  page: Page,
  html: string,
  styles: string,
  options: PdfGenerationOptions,
  onCancel?: CancellationCallback,
): Promise<ExportResult> {
  const cleanHtml = sanitizeHtml(html);
  const printStyles = extractPrintStyles(styles);

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

  const timeout = calculateTimeout(html.length, options.timeout);

  if (onCancel?.()) {
    throw new Error('Export cancelled');
  }

  await page.setContent(fullHtml, {
    waitUntil: 'load',
    timeout,
  });

  if (onCancel?.()) {
    throw new Error('Export cancelled');
  }

  await page.evaluateHandle('document.fonts.ready');
  await page.waitForFunction('document.readyState === "complete"', {
    timeout: 5000,
  });

  if (onCancel?.()) {
    throw new Error('Export cancelled');
  }

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
