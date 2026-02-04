
// Image Generation Constants
const MAX_WIDTH = 2048;
const MAX_HEIGHT = 2048;
const MIN_WIDTH = 256;
const MIN_HEIGHT = 256;
const MAX_PROMPT_LENGTH = 10000;

// Rate Limiting Constants
export const RATE_LIMITS = {
  generation: {
    user: parseInt(process.env.RATE_LIMIT_USER_DAILY || '20', 10),
    admin: parseInt(process.env.RATE_LIMIT_ADMIN_DAILY || '200', 10),
  },
  augmentation: {
    user: parseInt(process.env.AUGMENTATION_LIMIT_USER_DAILY || '20', 10),
    admin: parseInt(process.env.AUGMENTATION_LIMIT_ADMIN_DAILY || '200', 10),
  }
};

// Backwards compatibility
const USER_DAILY_LIMIT = RATE_LIMITS.generation.user;
const ADMIN_DAILY_LIMIT = RATE_LIMITS.generation.admin;

// Cache Constants
const PRESIGNED_S3_URL_EXPIRATION = 900; // 15 minutes in seconds
const URL_CACHE_TTL = PRESIGNED_S3_URL_EXPIRATION;
const METADATA_CACHE_TTL = 86400; // 24 hours in seconds

// Custom Style Prompt Constants
const MAX_CUSTOM_STYLE_PROMPT_LENGTH = 2000;
const MAX_CUSTOM_STYLE_PROMPTS_PER_USER = 50;

// Thread Color Constants - Material Design 500 shades
// Optimized order: purple first, alternating warm/cool for variety
export const THREAD_COLORS = [
  '#9C27B0', // Purple (cool, vibrant)
  '#009688', // Teal (cool, deep)
  '#FFC107', // Amber (warm, bright)
  '#3F51B5', // Indigo (cool, deep)
  '#FF9800', // Orange (warm, medium)
  '#2196F3', // Blue (cool, bright)
  '#4CAF50', // Green (neutral, medium)
  '#F44336', // Red (warm, bright)
  '#00BCD4', // Cyan (cool, bright)
  '#FF5722', // Deep Orange (warm, deep)
  '#673AB7', // Deep Purple (cool, deep)
  '#8BC34A', // Light Green (neutral, light)
  '#E91E63', // Pink (warm, medium)
  '#03A9F4', // Light Blue (cool, light)
];

export {
  MAX_WIDTH,
  MAX_HEIGHT,
  MIN_WIDTH,
  MIN_HEIGHT,
  MAX_PROMPT_LENGTH,
  URL_CACHE_TTL,
  PRESIGNED_S3_URL_EXPIRATION,
  METADATA_CACHE_TTL,
  MAX_CUSTOM_STYLE_PROMPT_LENGTH,
  MAX_CUSTOM_STYLE_PROMPTS_PER_USER,
  USER_DAILY_LIMIT,
  ADMIN_DAILY_LIMIT
};
