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
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          ${styles}

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

            /* Only prevent breaks inside headings and special elements */
            h1, h2, h3, h4, h5, h6, blockquote, pre {
              page-break-inside: avoid;
            }

            /* Keep headings with following content */
            h1, h2, h3, h4, h5, h6 {
              page-break-after: avoid;
            }

            /* Allow paragraph breaks but control orphans/widows */
            p {
              orphans: 3;
              widows: 3;
            }

            /* Allow list item breaks */
            li {
              orphans: 2;
              widows: 2;
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
  checkCancelled?: () => boolean,
): Promise<Buffer> {
  const page = await context.newPage();

  try {
    const wrappedHtml = wrapHtml(html, styles);

    if (checkCancelled?.()) {
      throw new Error('PDF generation cancelled');
    }

    await page.setContent(wrappedHtml, {
      waitUntil: 'load',
      timeout: 30000,
    });

    if (checkCancelled?.()) {
      throw new Error('PDF generation cancelled');
    }

    await page.evaluateHandle('document.fonts.ready');

    await page.waitForFunction('document.readyState === "complete"', {
      timeout: 5000,
    });

    if (checkCancelled?.()) {
      throw new Error('PDF generation cancelled');
    }

    const pdfBuffer = await page.pdf({
      format: options.format || 'a4',
      landscape: options.orientation === 'landscape',
      printBackground: true,
      preferCSSPageSize: false,
      margin: {
        top: '2.5cm',
        right: '2.5cm',
        bottom: '2.5cm',
        left: '2.5cm',
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
