/**
 * Alias Pattern Recognition
 *
 * Detects common alias patterns in entity names:
 * - Title variations (Count Dracula / the Count)
 * - Article stripping (The Boy Who Lived)
 * - Epithets (Harry Potter, The Chosen One)
 * - Full vs short names (Harry Potter / Harry)
 * - Phonetic similarity (Dracula / Drakula)
 */

type DoubleMetaphoneFn = (value: string) => [string, string];
let doubleMetaphone: DoubleMetaphoneFn | null = null;
let loadPromise: Promise<void> | null = null;

async function loadDoubleMetaphone(): Promise<void> {
  if (doubleMetaphone) return;
  if (loadPromise) {
    await loadPromise;
    return;
  }
  loadPromise = (async () => {
    const mod = await import('double-metaphone');
    doubleMetaphone = mod.doubleMetaphone;
  })();
  await loadPromise;
}

function getDoubleMetaphone(): DoubleMetaphoneFn {
  if (!doubleMetaphone) {
    throw new Error('Double Metaphone not loaded. Call loadDoubleMetaphone() first.');
  }
  return doubleMetaphone;
}

// ========== Title Patterns ==========

const TITLES = [
  'mr',
  'mrs',
  'ms',
  'miss',
  'dr',
  'professor',
  'prof',
  'sir',
  'lord',
  'lady',
  'count',
  'countess',
  'duke',
  'duchess',
  'king',
  'queen',
  'prince',
  'princess',
  'captain',
  'general',
  'colonel',
  'major',
  'sergeant',
  'detective',
  'officer',
  'father',
  'mother',
  'brother',
  'sister',
  'uncle',
  'aunt',
  'grandpa',
  'grandma',
  'grandfather',
  'grandmother',
];

const TITLE_PATTERN = new RegExp(`^(${TITLES.join('|')})\\.?\\s+`, 'i');

// ========== Article Patterns ==========

const ARTICLES = ['the', 'a', 'an', 'that', 'this'];
const ARTICLE_PATTERN = new RegExp(`^(${ARTICLES.join('|')})\\s+`, 'i');

// ========== Epithet Suffixes ==========

const EPITHET_SUFFIXES = [
  'the great',
  'the terrible',
  'the wise',
  'the brave',
  'the bold',
  'the elder',
  'the younger',
  'the first',
  'the second',
  'the third',
  'jr',
  'junior',
  'sr',
  'senior',
];

const EPITHET_SUFFIX_PATTERN = new RegExp(
  `,?\\s+(${EPITHET_SUFFIXES.join('|')})$`,
  'i'
);

// ========== Core Functions ==========

/**
 * Normalize a name by removing titles, articles, and epithets.
 */
export function normalizeNameForMatching(name: string): string {
  let normalized = name.toLowerCase().trim();

  // Remove leading articles
  normalized = normalized.replace(ARTICLE_PATTERN, '');

  // Remove leading titles
  normalized = normalized.replace(TITLE_PATTERN, '');

  // Remove epithet suffixes
  normalized = normalized.replace(EPITHET_SUFFIX_PATTERN, '');

  // Normalize whitespace
  normalized = normalized.replace(/\s+/g, ' ').trim();

  return normalized;
}

/**
 * Extract the title from a name if present.
 */
export function extractTitle(name: string): string | null {
  const match = name.match(TITLE_PATTERN);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Extract an epithet suffix from a name if present.
 */
export function extractEpithet(name: string): string | null {
  const match = name.match(EPITHET_SUFFIX_PATTERN);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Get all words from a name (after normalization).
 */
export function getNameTokens(name: string): string[] {
  return normalizeNameForMatching(name)
    .split(' ')
    .filter((w) => w.length > 1);
}

/**
 * Check if two names share significant tokens.
 * Returns the fraction of shared tokens.
 */
export function tokenOverlap(name1: string, name2: string): number {
  const tokens1 = new Set(getNameTokens(name1));
  const tokens2 = new Set(getNameTokens(name2));

  if (tokens1.size === 0 || tokens2.size === 0) return 0;

  let shared = 0;
  for (const t of tokens1) {
    if (tokens2.has(t)) shared++;
  }

  // Jaccard similarity
  const union = new Set([...tokens1, ...tokens2]);
  return shared / union.size;
}

/**
 * Check if one name is a substring of another (after normalization).
 */
export function isSubstringMatch(name1: string, name2: string): boolean {
  const norm1 = normalizeNameForMatching(name1);
  const norm2 = normalizeNameForMatching(name2);

  if (norm1.length < 2 || norm2.length < 2) return false;

  return norm1.includes(norm2) || norm2.includes(norm1);
}

/**
 * Check if two names have the same title (e.g., both "Count").
 */
export function shareTitle(name1: string, name2: string): boolean {
  const title1 = extractTitle(name1);
  const title2 = extractTitle(name2);
  return title1 !== null && title1 === title2;
}

/**
 * Detect if a name is likely an epithet reference.
 * Epithets are descriptive phrases like "The Boy Who Lived".
 */
export function isLikelyEpithet(name: string): boolean {
  const normalized = name.toLowerCase();

  // Starts with "the" and contains multiple words
  if (normalized.startsWith('the ') && normalized.split(' ').length >= 3) {
    return true;
  }

  // Contains common epithet patterns
  const epithetPatterns = [
    /who \w+/i, // "The Boy Who Lived"
    /of the /i, // "Lord of the Rings"
    /the \w+ one/i, // "The Chosen One"
  ];

  return epithetPatterns.some((p) => p.test(normalized));
}

/**
 * Get potential alias variants of a name.
 * Returns variations that might match the same entity.
 */
export function generateAliasVariants(name: string): string[] {
  const variants: string[] = [name];
  const normalized = normalizeNameForMatching(name);

  // Add normalized version
  if (normalized !== name.toLowerCase()) {
    variants.push(normalized);
  }

  // Add title only (e.g., "Count" from "Count Dracula")
  const title = extractTitle(name);
  if (title) {
    variants.push(title);
    // Add "the <title>" variant
    variants.push(`the ${title}`);
  }

  // Add first name only
  const tokens = getNameTokens(name);
  if (tokens.length > 1) {
    variants.push(tokens[0]);
    // Add last name only
    variants.push(tokens[tokens.length - 1]);
  }

  // Remove duplicates
  return [...new Set(variants.map((v) => v.toLowerCase()))];
}

/**
 * Compute a pattern-based alias score between two names.
 * Returns a score between 0 and 1 indicating alias likelihood.
 */
export function computeAliasPatternScore(name1: string, name2: string): number {
  // Exact match after normalization
  if (normalizeNameForMatching(name1) === normalizeNameForMatching(name2)) {
    return 1.0;
  }

  // Substring match
  if (isSubstringMatch(name1, name2)) {
    return 0.85;
  }

  // Same title (e.g., both "Count")
  if (shareTitle(name1, name2)) {
    return 0.7;
  }

  // Token overlap
  const overlap = tokenOverlap(name1, name2);
  if (overlap > 0) {
    return 0.5 + overlap * 0.3;
  }

  return 0;
}

// ========== Phonetic Matching ==========

/**
 * Ensure phonetic matching is ready to use.
 * Call this before using phoneticMatch or getPhoneticCodes.
 */
export async function ensurePhoneticReady(): Promise<void> {
  await loadDoubleMetaphone();
}

/**
 * Check if two names match phonetically using Double Metaphone.
 * Returns true if primary phonetic codes match and are at least 2 characters.
 * Returns false if phonetic library not loaded.
 */
export function phoneticMatch(name1: string, name2: string): boolean {
  if (!doubleMetaphone) return false;

  const norm1 = normalizeNameForMatching(name1);
  const norm2 = normalizeNameForMatching(name2);

  if (norm1.length < 2 || norm2.length < 2) return false;

  const dm = getDoubleMetaphone();
  const [p1] = dm(norm1);
  const [p2] = dm(norm2);

  return p1 === p2 && p1.length >= 2;
}

/**
 * Get all phonetic codes for a name's tokens.
 * Returns array of primary metaphone codes for each token.
 * Returns empty array if phonetic library not loaded.
 */
export function getPhoneticCodes(name: string): string[] {
  if (!doubleMetaphone) return [];

  const dm = getDoubleMetaphone();
  const tokens = getNameTokens(name);
  return tokens.map((t) => dm(t)[0]).filter((c) => c.length >= 2);
}
