/**
 * Mentions module - links graph nodes to text positions in documents.
 */

export { mentionService } from './mention.service';
export { fuzzyFindText, fuzzyFindTextInSegment } from './fuzzyMatch';
export { findNameOccurrences, nameMatchesToMentionInputs } from './nameMatch';
export type {
  Mention,
  MentionSource,
  CreateMentionInput,
  MentionWithAbsolutePosition,
} from './mention.types';
export type { FuzzyMatchResult, FuzzyMatchInput } from './fuzzyMatch';
export type { NameMatchConfig, NameMatchResult } from './nameMatch';
