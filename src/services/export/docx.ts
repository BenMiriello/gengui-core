/**
 * DOCX Export using native Word XML format
 *
 * This implementation uses the 'docx' library to generate proper Word XML
 * that works in all DOCX readers including macOS Preview.
 *
 * Previous implementation used html-docx-js which embeds HTML as altChunk,
 * which doesn't work in macOS Preview or other lightweight viewers.
 */
export { generateDocxNative as generateDocx } from './docx-native';
