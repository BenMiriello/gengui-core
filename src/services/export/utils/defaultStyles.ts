/**
 * Default styles for PDF/DOCX exports
 * Based on common TipTap ProseMirror styles
 */
export const DEFAULT_EXPORT_STYLES = `
  * {
    box-sizing: border-box;
  }

  body {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 12pt;
    line-height: 1.6;
    color: #000000;
    margin: 0;
    padding: 0;
  }

  .ProseMirror, .editor-content {
    max-width: 100%;
    padding: 0;
  }

  h1 {
    font-size: 24pt;
    font-weight: bold;
    margin: 16pt 0 8pt 0;
    page-break-after: avoid;
  }

  h2 {
    font-size: 20pt;
    font-weight: bold;
    margin: 14pt 0 6pt 0;
    page-break-after: avoid;
  }

  h3 {
    font-size: 16pt;
    font-weight: bold;
    margin: 12pt 0 4pt 0;
    page-break-after: avoid;
  }

  p {
    margin: 6pt 0;
    orphans: 3;
    widows: 3;
  }

  ul, ol {
    margin: 6pt 0;
    padding-left: 24pt;
  }

  li {
    margin: 2pt 0;
  }

  blockquote {
    border-left: 3px solid #ccc;
    margin: 8pt 0;
    padding-left: 12pt;
    font-style: italic;
  }

  code {
    background-color: #f4f4f4;
    padding: 2pt 4pt;
    border-radius: 3pt;
    font-family: 'Courier New', monospace;
    font-size: 11pt;
  }

  pre {
    background-color: #f4f4f4;
    padding: 8pt;
    border-radius: 4pt;
    overflow-x: auto;
    page-break-inside: avoid;
  }

  a {
    color: #0066cc;
    text-decoration: underline;
  }

  strong {
    font-weight: bold;
  }

  em {
    font-style: italic;
  }

  u {
    text-decoration: underline;
  }

  @media print {
    * {
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    h1, h2, h3, h4, h5, h6 {
      page-break-after: avoid;
      break-after: avoid;
    }

    blockquote, pre {
      page-break-inside: avoid;
      break-inside: avoid;
    }
  }
`;
