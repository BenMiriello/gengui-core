/**
 * Mentions module - links graph nodes to text positions in documents.
 */

export type { FuzzyMatchInput, FuzzyMatchResult } from './fuzzyMatch';
export { fuzzyFindText, fuzzyFindTextInSegment } from './fuzzyMatch';
export { mentionService } from './mention.service';
export type {
  CreateMentionInput,
  Mention,
  MentionSource,
  MentionWithAbsolutePosition,
} from './mention.types';
export type { NameMatchConfig, NameMatchResult } from './nameMatch';
export { findNameOccurrences, nameMatchesToMentionInputs } from './nameMatch';
