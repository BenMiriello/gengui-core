import { Node } from '@tiptap/core';

/**
 * Segment extension - Block node with UUID
 * Matches frontend implementation for text-grounded entity anchoring
 */
export const Segment = Node.create({
  name: 'segment',
  group: 'block',
  content: 'block+',

  addAttributes() {
    return {
      'data-segment-id': {
        default: null,
        parseHTML: (element) => element.getAttribute('data-segment-id'),
        renderHTML: (attributes) => ({
          'data-segment-id': attributes['data-segment-id'],
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-segment-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', HTMLAttributes, 0];
  },
});

/**
 * FontSize extension - Custom mark for font sizing
 * Matches frontend implementation
 */
export const FontSize = Node.create({
  name: 'fontSize',
  addOptions() {
    return {
      types: ['textStyle'],
    };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) =>
              element.style.fontSize?.replace(/['"]+/g, ''),
            renderHTML: (attributes) => {
              if (!attributes.fontSize) {
                return {};
              }

              return {
                style: `font-size: ${attributes.fontSize}`,
              };
            },
          },
        },
      },
    ];
  },
});
