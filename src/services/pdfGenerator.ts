import type { BrowserContext } from 'puppeteer';
import { logger } from '../utils/logger';

interface PdfOptions {
  format?: 'a4' | 'letter';
  orientation?: 'portrait' | 'landscape';
}

function wrapHtml(content: string, styles: string): string {
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <style>
          ${styles}

          @media print {
            /* Avoid page breaks inside elements */
            p, h1, h2, h3, h4, h5, h6, li {
              page-break-inside: avoid;
            }

            /* Avoid orphans and widows */
            p {
              orphans: 3;
              widows: 3;
            }
          }
        </style>
      </head>
      <body>${content}</body>
    </html>
  `;
}

export async function generatePdf(
  context: BrowserContext,
  html: string,
  styles: string,
  options: PdfOptions = {},
): Promise<Buffer> {
  const page = await context.newPage();

  try {
    const wrappedHtml = wrapHtml(html, styles);
    await page.setContent(wrappedHtml, {
      waitUntil: 'load',
      timeout: 30000,
    });

    await page.evaluateHandle('document.fonts.ready');

    const pdfBuffer = await page.pdf({
      format: options.format || 'a4',
      landscape: options.orientation === 'landscape',
      printBackground: true,
      margin: {
        top: '1cm',
        right: '1cm',
        bottom: '1cm',
        left: '1cm',
      },
    });

    logger.debug(
      { size: pdfBuffer.length, format: options.format || 'a4' },
      'PDF generated successfully',
    );

    return Buffer.from(pdfBuffer);
  } catch (error) {
    logger.error({ error }, 'Failed to generate PDF');
    throw error;
  } finally {
    await page.close();
  }
}
