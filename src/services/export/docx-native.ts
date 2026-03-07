import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import type { ChildNode, Element } from 'domhandler';
import { isTag, isText } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import { logger } from '../../utils/logger';
import type {
  CancellationCallback,
  ExportOptions,
  ExportResult,
} from './types';
import { sanitizeHtml } from './utils/htmlProcessor';

interface DocxGenerationOptions extends ExportOptions {
  cssVariables?: Record<string, string>;
}

function htmlToDocxParagraphs(html: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const dom = parseDocument(html);
  const tagCounts: Record<string, number> = {};

  function processNode(
    node: ChildNode,
    parentFormatting: {
      bold?: boolean;
      italic?: boolean;
      underline?: boolean;
    } = {},
  ): TextRun[] {
    if (isText(node)) {
      const text = node.data;
      if (!text.trim()) return [];

      return [
        new TextRun({
          text: text,
          bold: parentFormatting.bold,
          italics: parentFormatting.italic,
          underline: parentFormatting.underline
            ? { type: 'single' }
            : undefined,
        }),
      ];
    }

    if (!isTag(node)) return [];

    const element = node;
    const tagName = element.name.toLowerCase();
    tagCounts[tagName] = (tagCounts[tagName] || 0) + 1;
    const children = element.children || [];

    // Update formatting based on tag
    const newFormatting = { ...parentFormatting };
    if (tagName === 'strong' || tagName === 'b') {
      newFormatting.bold = true;
    }
    if (tagName === 'em' || tagName === 'i') {
      newFormatting.italic = true;
    }
    if (tagName === 'u') {
      newFormatting.underline = true;
    }

    // Process inline elements
    if (['strong', 'b', 'em', 'i', 'u', 'span'].includes(tagName)) {
      const runs: TextRun[] = [];
      for (const child of children) {
        runs.push(...processNode(child, newFormatting));
      }
      return runs;
    }

    // Block elements create paragraphs
    if (tagName === 'p') {
      const runs: TextRun[] = [];
      for (const child of children) {
        runs.push(...processNode(child, newFormatting));
      }
      if (runs.length > 0) {
        paragraphs.push(new Paragraph({ children: runs }));
      }
      return [];
    }

    if (tagName === 'h1') {
      const runs: TextRun[] = [];
      for (const child of children) {
        runs.push(...processNode(child, { ...newFormatting, bold: true }));
      }
      paragraphs.push(
        new Paragraph({ children: runs, heading: HeadingLevel.HEADING_1 }),
      );
      return [];
    }

    if (tagName === 'h2') {
      const runs: TextRun[] = [];
      for (const child of children) {
        runs.push(...processNode(child, { ...newFormatting, bold: true }));
      }
      paragraphs.push(
        new Paragraph({ children: runs, heading: HeadingLevel.HEADING_2 }),
      );
      return [];
    }

    if (tagName === 'h3') {
      const runs: TextRun[] = [];
      for (const child of children) {
        runs.push(...processNode(child, { ...newFormatting, bold: true }));
      }
      paragraphs.push(
        new Paragraph({ children: runs, heading: HeadingLevel.HEADING_3 }),
      );
      return [];
    }

    if (tagName === 'ul' || tagName === 'ol') {
      for (const child of children) {
        if ((child as Element).name === 'li') {
          const runs: TextRun[] = [];
          for (const liChild of (child as Element).children || []) {
            runs.push(...processNode(liChild, newFormatting));
          }
          paragraphs.push(
            new Paragraph({
              children: runs,
              bullet: tagName === 'ul' ? { level: 0 } : undefined,
              numbering:
                tagName === 'ol'
                  ? { reference: 'default', level: 0 }
                  : undefined,
            }),
          );
        }
      }
      return [];
    }

    if (tagName === 'blockquote') {
      for (const child of children) {
        const runs: TextRun[] = [];
        if ((child as Element).name === 'p') {
          for (const pChild of (child as Element).children || []) {
            runs.push(
              ...processNode(pChild, { ...newFormatting, italic: true }),
            );
          }
          paragraphs.push(
            new Paragraph({
              children: runs,
              indent: { left: 720 }, // 0.5 inch
            }),
          );
        }
      }
      return [];
    }

    if (tagName === 'br') {
      paragraphs.push(new Paragraph({ children: [] }));
      return [];
    }

    // For div and other containers, just process children
    if (['div', 'article', 'section', 'body', 'html'].includes(tagName)) {
      for (const child of children) {
        processNode(child, newFormatting);
      }
      return [];
    }

    // Default: process children
    const runs: TextRun[] = [];
    for (const child of children) {
      runs.push(...processNode(child, newFormatting));
    }
    return runs;
  }

  // Process all nodes
  for (const node of dom.children) {
    processNode(node);
  }

  // Ensure at least one paragraph
  if (paragraphs.length === 0) {
    paragraphs.push(new Paragraph({ children: [new TextRun('')] }));
  }

  // Debug: check paragraph content distribution
  const nonEmptyParagraphs = paragraphs.filter(
    (p) => (p as any).root?.length > 0,
  );
  const paragraphsWithText = paragraphs.filter((p) => {
    const children = (p as any).root || [];
    return children.some((child: any) => child?.text?.length > 0);
  });
  logger.info(
    {
      total: paragraphs.length,
      nonEmpty: nonEmptyParagraphs.length,
      withText: paragraphsWithText.length,
      tagCounts,
    },
    'DOCX: Paragraph analysis',
  );

  return paragraphs;
}

export async function generateDocxNative(
  html: string,
  _styles: string,
  _options: DocxGenerationOptions,
  onCancel?: CancellationCallback,
): Promise<ExportResult> {
  // Check for cancellation early
  if (onCancel?.()) {
    throw new Error('Export cancelled');
  }

  // Sanitize HTML
  const cleanHtml = sanitizeHtml(html);
  logger.info(
    {
      inputHtmlLength: html.length,
      cleanHtmlLength: cleanHtml.length,
    },
    'DOCX: Sanitized HTML',
  );

  // Convert HTML to paragraphs
  const paragraphs = htmlToDocxParagraphs(cleanHtml);
  logger.info(
    { paragraphCount: paragraphs.length },
    'DOCX: Generated paragraphs from HTML',
  );

  // Check cancellation before heavy processing
  if (onCancel?.()) {
    throw new Error('Export cancelled');
  }

  // Create document
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1440, // 1 inch in twips
              right: 1440,
              bottom: 1440,
              left: 1440,
            },
          },
        },
        children: paragraphs,
      },
    ],
  });

  logger.info(
    {
      sectionCount: (doc as any).Sections?.length || 'unknown',
      firstSectionChildCount: paragraphs.length,
    },
    'DOCX: Document created',
  );

  // Generate DOCX buffer
  const buffer = await Packer.toBuffer(doc);

  logger.info({ bufferSize: buffer.byteLength }, 'DOCX: Buffer generated');

  return {
    buffer: Buffer.from(buffer),
    mimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
  };
}
