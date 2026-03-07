import type { JSONContent } from '@tiptap/core';
import { generateHTML } from '@tiptap/core';
import FontFamily from '@tiptap/extension-font-family';
import Link from '@tiptap/extension-link';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import Underline from '@tiptap/extension-underline';
import StarterKit from '@tiptap/starter-kit';
import { FontSize, Segment } from './tiptapExtensions';

/**
 * Convert TipTap JSON to HTML using the same extensions as frontend
 */
export function documentToHtml(contentJson: JSONContent): string {
  if (!contentJson || typeof contentJson !== 'object') {
    throw new Error('Invalid contentJson: must be TipTap JSON object');
  }

  if (contentJson.type !== 'doc' || !Array.isArray(contentJson.content)) {
    throw new Error('Invalid TipTap JSON: missing doc type or content array');
  }

  const extensions = [
    StarterKit,
    TextStyle,
    FontFamily.configure({
      types: ['textStyle'],
    }),
    Link.configure({
      openOnClick: false,
      HTMLAttributes: {
        target: '_blank',
        rel: 'noopener noreferrer nofollow',
      },
    }),
    Underline,
    TextAlign.configure({
      types: ['heading', 'paragraph'],
    }),
    Segment,
    FontSize,
  ];

  const html = generateHTML(contentJson, extensions);

  return html;
}
