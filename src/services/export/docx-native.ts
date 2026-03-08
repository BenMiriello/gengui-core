import AdmZip from 'adm-zip';
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

  let textNodeCount = 0;
  let textTotalLength = 0;
  let totalRunsCreated = 0;
  let emptyRunsParagraphs = 0;
  const sampleTexts: string[] = []; // First 3 text samples

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
      textNodeCount++;
      textTotalLength += text.length;
      if (!text.trim()) return [];

      // Sample first 3 non-empty texts
      if (sampleTexts.length < 3) {
        sampleTexts.push(text.substring(0, 100));
      }

      const run = new TextRun({
        text: text,
        bold: parentFormatting.bold,
        italics: parentFormatting.italic,
        underline: parentFormatting.underline
          ? { type: 'single' }
          : undefined,
      });
      totalRunsCreated++;
      return [run];
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

      if (runs.length === 0) {
        emptyRunsParagraphs++;
      }

      // Detailed logging for first paragraph
      if (paragraphs.length === 0) {
        const firstRun = runs[0] as any;
        logger.info(
          {
            runsCount: runs.length,
            firstRunType: firstRun?.constructor?.name,
            firstRunRoot: firstRun?.root
              ? JSON.stringify(firstRun.root).substring(0, 500)
              : 'no root',
            firstRunOptions: firstRun?.options
              ? JSON.stringify(firstRun.options).substring(0, 500)
              : 'no options',
          },
          'DOCX: First <p> tag processing',
        );
      }

      if (runs.length > 0) {
        const para = new Paragraph({ children: runs });
        // Verify paragraph has the runs
        if (paragraphs.length === 0) {
          const paraAny = para as any;
          logger.info(
            {
              paraRootLength: paraAny.root?.length,
              paraRoot: paraAny.root
                ? JSON.stringify(paraAny.root).substring(0, 800)
                : 'no root',
            },
            'DOCX: First Paragraph after construction',
          );
        }
        paragraphs.push(para);
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
      textNodeCount,
      textTotalLength,
      totalRunsCreated,
      emptyRunsParagraphs,
      sampleTexts,
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

  // Inspect the document structure
  const docAny = doc as any;
  const sections = docAny.document?.body?.sections || [];
  logger.info(
    {
      docKeys: Object.keys(docAny),
      documentKeys: docAny.document ? Object.keys(docAny.document) : [],
      sectionsCount: sections.length,
      firstSectionChildren: sections[0]?.children?.length || 'no children prop',
      paragraphsPassedIn: paragraphs.length,
    },
    'DOCX: Document created',
  );

  // Generate DOCX buffer
  const buffer = await Packer.toBuffer(doc);

  // DOCX is a zip file - extract document.xml to check content
  const bufferStart = Buffer.from(buffer).toString('hex', 0, 4);
  const isZip = bufferStart === '504b0304'; // PK\x03\x04 = ZIP signature

  // Extract document.xml from the ZIP to inspect actual content
  let documentXmlLength = 0;
  let paragraphCountInXml = 0;
  let hasBody = false;
  let hasSectPr = false;
  let firstParagraphXml = '';
  let lastParagraphXml = '';
  try {
    const zip = new AdmZip(Buffer.from(buffer));
    const docXmlEntry = zip.getEntry('word/document.xml');
    if (docXmlEntry) {
      const docXml = docXmlEntry.getData().toString('utf8');
      documentXmlLength = docXml.length;
      // Count <w:p> tags (paragraphs in Word XML)
      paragraphCountInXml = (docXml.match(/<w:p[>\s]/g) || []).length;
      hasBody = docXml.includes('<w:body>');
      hasSectPr = docXml.includes('<w:sectPr');
      // Extract first paragraph
      const firstPMatch = docXml.match(/<w:p[>\s][^]*?<\/w:p>/);
      if (firstPMatch) {
        firstParagraphXml = firstPMatch[0].substring(0, 500);
      }
      // Extract last paragraph (search from end)
      const lastPMatch = docXml.match(/<w:p[>\s][^]*<\/w:p>(?![\s\S]*<w:p)/);
      if (lastPMatch) {
        lastParagraphXml = lastPMatch[0].substring(0, 500);
      }
    }
  } catch (e) {
    logger.warn({ error: (e as Error).message }, 'DOCX: Failed to extract document.xml');
  }

  logger.info(
    {
      bufferSize: buffer.byteLength,
      isValidZip: isZip,
      documentXmlLength,
      paragraphCountInXml,
      hasBody,
      hasSectPr,
      firstParagraphXml,
      lastParagraphXml,
    },
    'DOCX: Buffer generated',
  );

  return {
    buffer: Buffer.from(buffer),
    mimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
  };
}
