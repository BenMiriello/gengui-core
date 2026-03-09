import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import type { ChildNode, Element } from 'domhandler';
import { isTag, isText } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import { logger } from '../../utils/logger';
import type { CancellationCallback, ExportResult } from './types';
import { sanitizeHtml } from './utils/htmlProcessor';

const MAX_HTML_DEPTH = 100;

function htmlToDocxParagraphs(html: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const dom = parseDocument(html);

  function processNode(
    node: ChildNode,
    parentFormatting: {
      bold?: boolean;
      italic?: boolean;
      underline?: boolean;
    } = {},
    depth: number = 0,
  ): TextRun[] {
    if (depth > MAX_HTML_DEPTH) {
      logger.warn({ depth }, 'HTML nesting depth exceeded, truncating');
      return [];
    }

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
    const children = element.children || [];

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

    if (['strong', 'b', 'em', 'i', 'u', 'span'].includes(tagName)) {
      const runs: TextRun[] = [];
      for (const child of children) {
        runs.push(...processNode(child, newFormatting, depth + 1));
      }
      return runs;
    }

    if (tagName === 'p') {
      const runs: TextRun[] = [];
      for (const child of children) {
        runs.push(...processNode(child, newFormatting, depth + 1));
      }

      if (runs.length > 0) {
        paragraphs.push(new Paragraph({ children: runs }));
      }
      return [];
    }

    if (tagName === 'h1') {
      const runs: TextRun[] = [];
      for (const child of children) {
        runs.push(
          ...processNode(child, { ...newFormatting, bold: true }, depth + 1),
        );
      }
      paragraphs.push(
        new Paragraph({ children: runs, heading: HeadingLevel.HEADING_1 }),
      );
      return [];
    }

    if (tagName === 'h2') {
      const runs: TextRun[] = [];
      for (const child of children) {
        runs.push(
          ...processNode(child, { ...newFormatting, bold: true }, depth + 1),
        );
      }
      paragraphs.push(
        new Paragraph({ children: runs, heading: HeadingLevel.HEADING_2 }),
      );
      return [];
    }

    if (tagName === 'h3') {
      const runs: TextRun[] = [];
      for (const child of children) {
        runs.push(
          ...processNode(child, { ...newFormatting, bold: true }, depth + 1),
        );
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
            runs.push(...processNode(liChild, newFormatting, depth + 1));
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
              ...processNode(
                pChild,
                { ...newFormatting, italic: true },
                depth + 1,
              ),
            );
          }
          paragraphs.push(
            new Paragraph({
              children: runs,
              indent: { left: 720 },
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

    if (['div', 'article', 'section', 'body', 'html'].includes(tagName)) {
      for (const child of children) {
        processNode(child, newFormatting, depth + 1);
      }
      return [];
    }

    const runs: TextRun[] = [];
    for (const child of children) {
      runs.push(...processNode(child, newFormatting, depth + 1));
    }
    return runs;
  }

  for (const node of dom.children) {
    processNode(node);
  }

  if (paragraphs.length === 0) {
    paragraphs.push(new Paragraph({ children: [new TextRun('')] }));
  }

  return paragraphs;
}

export async function generateDocxNative(
  html: string,
  onCancel?: CancellationCallback,
): Promise<ExportResult> {
  if (onCancel?.()) {
    throw new Error('Export cancelled');
  }

  const cleanHtml = sanitizeHtml(html);
  const paragraphs = htmlToDocxParagraphs(cleanHtml);

  if (onCancel?.()) {
    throw new Error('Export cancelled');
  }

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1440,
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

  const buffer = await Packer.toBuffer(doc);

  logger.info({ size: buffer.byteLength }, 'DOCX export completed');

  return {
    buffer: Buffer.from(buffer),
    mimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
  };
}
