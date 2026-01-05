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
export const mediaTypeEnum = pgEnum('media_type', ['upload', 'generation']);
export const mediaStatusEnum = pgEnum('media_status', ['queued', 'processing', 'completed', 'failed']);

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  username: varchar('username', { length: 50 }).notNull().unique(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }),
  oauthProvider: varchar('oauth_provider', { length: 50 }),
  oauthProviderId: varchar('oauth_provider_id', { length: 255 }),
  emailVerified: boolean('email_verified').default(false).notNull(),
  pendingEmail: varchar('pending_email', { length: 255 }),
  defaultImageWidth: integer('default_image_width').default(1024),
  defaultImageHeight: integer('default_image_height').default(1024),
  defaultStylePreset: varchar('default_style_preset', { length: 50 }),
  hiddenPresetIds: text('hidden_preset_ids').array(),
  failedLoginAttempts: integer('failed_login_attempts').default(0).notNull(),
  lockedUntil: timestamp('locked_until'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: varchar('token', { length: 255 }).notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  tokenIdx: index('sessions_token_idx').on(table.token),
  userExpiresIdx: index('sessions_user_expires_idx').on(table.userId, table.expiresAt),
}));

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: varchar('token', { length: 255 }).notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  tokenIdx: index('password_reset_tokens_token_idx').on(table.token),
}));

export const emailVerificationTokens = pgTable('email_verification_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: varchar('token', { length: 255 }).notNull().unique(),
  email: varchar('email', { length: 255 }).notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  tokenIdx: index('email_verification_tokens_token_idx').on(table.token),
  userIdIdx: index('email_verification_tokens_user_id_idx').on(table.userId),
}));

export const media = pgTable('media', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  type: mediaTypeEnum('type').default('upload').notNull(),
  status: mediaStatusEnum('status').default('completed').notNull(),
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
  generated: boolean('generated').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  deletedAt: timestamp('deleted_at'),
}, (table) => ({
  userIdIdx: index('media_user_id_idx').on(table.userId),
  createdAtIdx: index('media_created_at_idx').on(table.createdAt),
  hashIdx: index('media_hash_idx').on(table.hash),
  typeStatusIdx: index('media_type_status_idx').on(table.type, table.status),
  userTypeIdx: index('media_user_type_idx').on(table.userId, table.type),
  userCreatedIdx: index('media_user_created_idx').on(table.userId, table.createdAt),
  s3KeyThumbIdx: index('media_s3_key_thumb_idx')
    .on(table.s3KeyThumb)
    .where(sql`s3_key_thumb IS NOT NULL`),
  userHashActiveIdx: index('media_user_hash_active_idx')
    .on(table.userId, table.hash)
    .where(sql`deleted_at IS NULL`),
  userCreatedActiveIdx: index('media_user_created_active_idx')
    .on(table.userId, table.createdAt)
    .where(sql`deleted_at IS NULL`),
  uniqueUserHash: uniqueIndex('media_user_hash_unique')
    .on(table.userId, table.hash)
    .where(sql`deleted_at IS NULL`),
}));

export const tags = pgTable('tags', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
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
  (table) => ({
    pk: primaryKey({ columns: [table.mediaId, table.tagId] }),
    tagIdIdx: index('media_tags_tag_id_idx').on(table.tagId),
  })
);

export const models = pgTable('models', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  type: modelTypeEnum('type').notNull(),
  filePath: varchar('file_path', { length: 512 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  deletedAt: timestamp('deleted_at'),
}, (table) => ({
  userActiveIdx: index('models_user_active_idx')
    .on(table.userId)
    .where(sql`deleted_at IS NULL`),
}));

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
  (table) => ({
    pk: primaryKey({ columns: [table.modelId, table.mediaId] }),
    modelIdIdx: index('model_inputs_model_id_idx').on(table.modelId),
  })
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
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  deletedAt: timestamp('deleted_at'),
}, (table) => ({
  userIdIdx: index('documents_user_id_idx').on(table.userId),
  updatedAtIdx: index('documents_updated_at_idx').on(table.updatedAt),
  userActiveIdx: index('documents_user_active_idx')
    .on(table.userId, table.deletedAt)
    .where(sql`deleted_at IS NULL`),
}));

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
  createdAt: timestamp('created_at').defaultNow().notNull(),
  deletedAt: timestamp('deleted_at'),
}, (table) => ({
  documentIdIdx: index('document_media_document_id_idx').on(table.documentId),
  mediaIdIdx: index('document_media_media_id_idx').on(table.mediaId),
  documentActiveIdx: index('document_media_document_active_idx')
    .on(table.documentId)
    .where(sql`deleted_at IS NULL`),
}));

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
}));

export const userStylePrompts = pgTable('user_style_prompts', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  prompt: text('prompt').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  deletedAt: timestamp('deleted_at'),
}, (table) => ({
  userIdIdx: index('user_style_prompts_user_id_idx').on(table.userId),
  userActiveIdx: index('user_style_prompts_user_active_idx')
    .on(table.userId)
    .where(sql`deleted_at IS NULL`),
}));

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
