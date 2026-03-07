/**
 * Extract print-friendly CSS for exports
 * - Remove animations, transitions, transforms
 * - Add page break rules
 */
export function extractPrintStyles(styles: string): string {
  let cleaned = styles;

  // Remove animations/transitions
  cleaned = cleaned.replace(/animation[^;]*;/g, '');
  cleaned = cleaned.replace(/transition[^;]*;/g, '');
  cleaned = cleaned.replace(/transform[^;]*;/g, '');

  // Add print-specific rules
  cleaned += `
    @media print {
      * {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }

      h1, h2, h3, h4, h5, h6 {
        page-break-after: avoid;
        break-after: avoid;
      }

      p, li {
        orphans: 3;
        widows: 3;
      }

      pre, blockquote {
        page-break-inside: avoid;
        break-inside: avoid;
      }
    }
  `;

  return cleaned;
}

/**
 * Resolve CSS variables to static values
 * Required for DOCX (doesn't support CSS variables)
 */
export function resolveCssVariables(
  styles: string,
  variables: Record<string, string>,
): string {
  let resolved = styles;

  for (const [varName, value] of Object.entries(variables)) {
    const regex = new RegExp(
      `var\\(${varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`,
      'g',
    );
    resolved = resolved.replace(regex, value.trim());
  }

  return resolved;
}
