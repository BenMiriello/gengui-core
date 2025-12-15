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

export const media = pgTable('media', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  type: mediaTypeEnum('type').default('upload').notNull(),
  status: mediaStatusEnum('status').default('completed').notNull(),
  storageKey: varchar('storage_key', { length: 512 }),
  s3Key: varchar('s3_key', { length: 512 }),
  s3Bucket: varchar('s3_bucket', { length: 255 }),
  size: integer('size'),
  mimeType: varchar('mime_type', { length: 100 }),
  hash: varchar('hash', { length: 64 }),
  width: integer('width'),
  height: integer('height'),
  prompt: text('prompt'),
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

export const usersRelations = relations(users, ({ many }) => ({
  media: many(media),
  tags: many(tags),
  models: many(models),
  sessions: many(sessions),
  passwordResetTokens: many(passwordResetTokens),
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

export const mediaRelations = relations(media, ({ one, many }) => ({
  user: one(users, {
    fields: [media.userId],
    references: [users.id],
  }),
  mediaTags: many(mediaTags),
  modelInputs: many(modelInputs),
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
