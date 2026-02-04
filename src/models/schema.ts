import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  boolean,
  pgEnum,
  primaryKey,
  index,
  uniqueIndex,
  text,
  jsonb,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

export const modelTypeEnum = pgEnum('model_type', ['lora', 'checkpoint', 'other']);
export const sourceTypeEnum = pgEnum('source_type', ['upload', 'generation']);
export const mediaStatusEnum = pgEnum('media_status', ['queued', 'augmenting', 'processing', 'completed', 'failed']);
export const userRoleEnum = pgEnum('user_role', ['user', 'admin']);

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  username: varchar('username', { length: 50 }).notNull().unique(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }),
  oauthProvider: varchar('oauth_provider', { length: 50 }),
  oauthProviderId: varchar('oauth_provider_id', { length: 255 }),
  role: userRoleEnum('role').default('user').notNull(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  pendingEmail: varchar('pending_email', { length: 255 }),
  defaultImageWidth: integer('default_image_width').default(1024),
  defaultImageHeight: integer('default_image_height').default(1024),
  defaultStylePreset: varchar('default_style_preset', { length: 50 }),
  hiddenPresetIds: text('hidden_preset_ids').array(),
  nodeTypeStyleDefaults: jsonb('node_type_style_defaults'),
  failedLoginAttempts: integer('failed_login_attempts').default(0).notNull(),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: varchar('token', { length: 255 }).notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: text('user_agent'),
}, (table) => ([
  index('sessions_token_idx').on(table.token),
  index('sessions_user_expires_idx').on(table.userId, table.expiresAt),
]));

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: varchar('token', { length: 255 }).notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ([
  index('password_reset_tokens_token_idx').on(table.token),
]));

export const emailVerificationTokens = pgTable('email_verification_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: varchar('token', { length: 255 }).notNull().unique(),
  email: varchar('email', { length: 255 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ([
  index('email_verification_tokens_token_idx').on(table.token),
  index('email_verification_tokens_user_id_idx').on(table.userId),
]));

export const media = pgTable('media', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  sourceType: sourceTypeEnum('source_type').default('upload').notNull(),
  status: mediaStatusEnum('status').default('completed').notNull(),
  mediaRole: varchar('media_role', { length: 20 }),
  storageKey: varchar('storage_key', { length: 512 }),
  s3Key: varchar('s3_key', { length: 512 }),
  s3KeyThumb: varchar('s3_key_thumb', { length: 512 }),
  s3Bucket: varchar('s3_bucket', { length: 255 }),
  size: integer('size'),
  mimeType: varchar('mime_type', { length: 100 }),
  hash: varchar('hash', { length: 64 }),
  width: integer('width'),
  height: integer('height'),
  prompt: text('prompt'),
  stylePreset: varchar('style_preset', { length: 50 }),
  stylePrompt: text('style_prompt'),
  seed: integer('seed'),
  error: text('error'),
  attempts: integer('attempts').default(0).notNull(),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  generated: boolean('generated').default(false).notNull(),
  generationSettings: jsonb('generation_settings'),
  generationSettingsSchemaVersion: integer('generation_settings_schema_version'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ([
  index('media_user_id_idx').on(table.userId),
  index('media_created_at_idx').on(table.createdAt),
  index('media_hash_idx').on(table.hash),
  index('media_source_type_status_idx').on(table.sourceType, table.status),
  index('media_user_source_type_idx').on(table.userId, table.sourceType),
  index('media_user_created_idx').on(table.userId, table.createdAt),
  index('media_role_idx').on(table.mediaRole).where(sql`media_role IS NOT NULL`),
  index('media_s3_key_thumb_idx')
    .on(table.s3KeyThumb)
    .where(sql`s3_key_thumb IS NOT NULL`),
  index('media_user_hash_active_idx')
    .on(table.userId, table.hash)
    .where(sql`deleted_at IS NULL`),
  index('media_user_created_active_idx')
    .on(table.userId, table.createdAt)
    .where(sql`deleted_at IS NULL`),
  uniqueIndex('media_user_hash_unique')
    .on(table.userId, table.hash)
    .where(sql`deleted_at IS NULL`),
]));

export const tags = pgTable('tags', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const mediaTags = pgTable(
  'media_tags',
  {
    mediaId: uuid('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (table) => ([
    primaryKey({ columns: [table.mediaId, table.tagId] }),
    index('media_tags_tag_id_idx').on(table.tagId),
  ])
);

export const models = pgTable('models', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  type: modelTypeEnum('type').notNull(),
  filePath: varchar('file_path', { length: 512 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ([
  index('models_user_active_idx')
    .on(table.userId)
    .where(sql`deleted_at IS NULL`),
]));

export const modelInputs = pgTable(
  'model_inputs',
  {
    modelId: uuid('model_id')
      .notNull()
      .references(() => models.id, { onDelete: 'cascade' }),
    mediaId: uuid('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
  },
  (table) => ([
    primaryKey({ columns: [table.modelId, table.mediaId] }),
    index('model_inputs_model_id_idx').on(table.modelId),
  ])
);

export const documents = pgTable('documents', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 100 }).notNull(),
  content: text('content').notNull(),
  contentJson: jsonb('content_json'),
  defaultStylePreset: varchar('default_style_preset', { length: 50 }),
  defaultStylePrompt: text('default_style_prompt'),
  defaultImageWidth: integer('default_image_width').default(1024),
  defaultImageHeight: integer('default_image_height').default(1024),
  narrativeModeEnabled: boolean('narrative_mode_enabled').default(false).notNull(),
  mediaModeEnabled: boolean('media_mode_enabled').default(false).notNull(),
  currentVersion: integer('current_version').default(0).notNull(),
  segmentSequence: jsonb('segment_sequence').default([]).notNull(),
  yjsState: text('yjs_state'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ([
  index('documents_user_id_idx').on(table.userId),
  index('documents_updated_at_idx').on(table.updatedAt),
  index('documents_user_active_idx')
    .on(table.userId, table.deletedAt)
    .where(sql`deleted_at IS NULL`),
]));

export const documentMedia = pgTable('document_media', {
  id: uuid('id').defaultRandom().primaryKey(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  mediaId: uuid('media_id')
    .notNull()
    .references(() => media.id, { onDelete: 'cascade' }),
  startChar: integer('start_char'),
  endChar: integer('end_char'),
  nodePos: integer('node_pos'),
  textOffset: integer('text_offset'),
  sourceText: text('source_text'),
  contextBefore: text('context_before'),
  contextAfter: text('context_after'),
  requestedPrompt: text('requested_prompt'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ([
  index('document_media_document_id_idx').on(table.documentId),
  index('document_media_media_id_idx').on(table.mediaId),
  index('document_media_document_active_idx')
    .on(table.documentId)
    .where(sql`deleted_at IS NULL`),
]));

export const documentVersions = pgTable('document_versions', {
  id: uuid('id').defaultRandom().primaryKey(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  versionNumber: integer('version_number').notNull(),
  yjsState: text('yjs_state').notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ([
  uniqueIndex('document_versions_unique').on(table.documentId, table.versionNumber),
  index('document_versions_lookup_idx').on(table.documentId, table.versionNumber),
]));

export const mentionSourceEnum = pgEnum('mention_source', [
  'extraction',
  'name_match',
  'reference',
  'semantic',
]);

export const mentions = pgTable('mentions', {
  id: uuid('id').defaultRandom().primaryKey(),
  nodeId: varchar('node_id', { length: 255 }).notNull(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  segmentId: varchar('segment_id', { length: 255 }).notNull(),
  relativeStart: integer('relative_start').notNull(),
  relativeEnd: integer('relative_end').notNull(),
  originalText: text('original_text').notNull(),
  textHash: varchar('text_hash', { length: 64 }).notNull(),
  confidence: integer('confidence').default(100).notNull(),
  versionNumber: integer('version_number').notNull(),
  source: mentionSourceEnum('source').default('extraction').notNull(),
  isKeyPassage: boolean('is_key_passage').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ([
  index('mentions_node_idx').on(table.nodeId),
  index('mentions_segment_idx').on(table.documentId, table.segmentId),
  index('mentions_version_idx').on(table.documentId, table.versionNumber),
  index('mentions_confidence_idx').on(table.confidence),
  index('mentions_source_idx').on(table.source),
]));

export const usersRelations = relations(users, ({ many }) => ({
  media: many(media),
  tags: many(tags),
  models: many(models),
  sessions: many(sessions),
  passwordResetTokens: many(passwordResetTokens),
  emailVerificationTokens: many(emailVerificationTokens),
  documents: many(documents),
  userStylePrompts: many(userStylePrompts),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const passwordResetTokensRelations = relations(passwordResetTokens, ({ one }) => ({
  user: one(users, {
    fields: [passwordResetTokens.userId],
    references: [users.id],
  }),
}));

export const emailVerificationTokensRelations = relations(emailVerificationTokens, ({ one }) => ({
  user: one(users, {
    fields: [emailVerificationTokens.userId],
    references: [users.id],
  }),
}));

export const mediaRelations = relations(media, ({ one, many }) => ({
  user: one(users, {
    fields: [media.userId],
    references: [users.id],
  }),
  mediaTags: many(mediaTags),
  modelInputs: many(modelInputs),
  documentMedia: many(documentMedia),
  nodeMedia: many(nodeMedia),
}));

export const tagsRelations = relations(tags, ({ one, many }) => ({
  user: one(users, {
    fields: [tags.userId],
    references: [users.id],
  }),
  mediaTags: many(mediaTags),
}));

export const mediaTagsRelations = relations(mediaTags, ({ one }) => ({
  media: one(media, {
    fields: [mediaTags.mediaId],
    references: [media.id],
  }),
  tag: one(tags, {
    fields: [mediaTags.tagId],
    references: [tags.id],
  }),
}));

export const modelsRelations = relations(models, ({ one, many }) => ({
  user: one(users, {
    fields: [models.userId],
    references: [users.id],
  }),
  modelInputs: many(modelInputs),
}));

export const modelInputsRelations = relations(modelInputs, ({ one }) => ({
  model: one(models, {
    fields: [modelInputs.modelId],
    references: [models.id],
  }),
  media: one(media, {
    fields: [modelInputs.mediaId],
    references: [media.id],
  }),
}));

export const documentsRelations = relations(documents, ({ one, many }) => ({
  user: one(users, {
    fields: [documents.userId],
    references: [users.id],
  }),
  documentMedia: many(documentMedia),
  versions: many(documentVersions),
  mentions: many(mentions),
}));

export const userStylePrompts = pgTable('user_style_prompts', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  prompt: text('prompt').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ([
  index('user_style_prompts_user_id_idx').on(table.userId),
  index('user_style_prompts_user_active_idx')
    .on(table.userId)
    .where(sql`deleted_at IS NULL`),
]));

export const nodeMedia = pgTable('node_media', {
  id: uuid('id').defaultRandom().primaryKey(),
  nodeId: varchar('node_id', { length: 255 }).notNull(),
  mediaId: uuid('media_id')
    .notNull()
    .references(() => media.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => ([
  index('node_media_node_idx').on(table.nodeId).where(sql`deleted_at IS NULL`),
  index('node_media_media_idx').on(table.mediaId).where(sql`deleted_at IS NULL`),
  uniqueIndex('node_media_unique').on(table.nodeId, table.mediaId),
]));

export const documentMediaRelations = relations(documentMedia, ({ one }) => ({
  document: one(documents, {
    fields: [documentMedia.documentId],
    references: [documents.id],
  }),
  media: one(media, {
    fields: [documentMedia.mediaId],
    references: [media.id],
  }),
}));

export const userStylePromptsRelations = relations(userStylePrompts, ({ one }) => ({
  user: one(users, {
    fields: [userStylePrompts.userId],
    references: [users.id],
  }),
}));

export const nodeMediaRelations = relations(nodeMedia, ({ one }) => ({
  media: one(media, {
    fields: [nodeMedia.mediaId],
    references: [media.id],
  }),
}));

export const documentVersionsRelations = relations(documentVersions, ({ one }) => ({
  document: one(documents, {
    fields: [documentVersions.documentId],
    references: [documents.id],
  }),
}));

export const mentionsRelations = relations(mentions, ({ one }) => ({
  document: one(documents, {
    fields: [mentions.documentId],
    references: [documents.id],
  }),
}));
