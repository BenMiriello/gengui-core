import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  decimal,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const modelTypeEnum = pgEnum('model_type', [
  'lora',
  'checkpoint',
  'other',
]);
export const sourceTypeEnum = pgEnum('source_type', ['upload', 'generation']);
export const mediaStatusEnum = pgEnum('media_status', [
  'queued',
  'augmenting',
  'processing',
  'completed',
  'failed',
]);
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
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: varchar('token', { length: 255 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
  },
  (table) => [
    index('sessions_token_idx').on(table.token),
    index('sessions_user_expires_idx').on(table.userId, table.expiresAt),
  ],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: varchar('token', { length: 255 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index('password_reset_tokens_token_idx').on(table.token)],
);

export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: varchar('token', { length: 255 }).notNull().unique(),
    email: varchar('email', { length: 255 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('email_verification_tokens_token_idx').on(table.token),
    index('email_verification_tokens_user_id_idx').on(table.userId),
  ],
);

export const media = pgTable(
  'media',
  {
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
    generationSettingsSchemaVersion: integer(
      'generation_settings_schema_version',
    ),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('media_user_id_idx').on(table.userId),
    index('media_created_at_idx').on(table.createdAt),
    index('media_hash_idx').on(table.hash),
    index('media_source_type_status_idx').on(table.sourceType, table.status),
    index('media_user_source_type_idx').on(table.userId, table.sourceType),
    index('media_user_created_idx').on(table.userId, table.createdAt),
    index('media_role_idx')
      .on(table.mediaRole)
      .where(sql`media_role IS NOT NULL`),
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
  ],
);

export const tags = pgTable('tags', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 100 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
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
  (table) => [
    primaryKey({ columns: [table.mediaId, table.tagId] }),
    index('media_tags_tag_id_idx').on(table.tagId),
  ],
);

export const models = pgTable(
  'models',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    type: modelTypeEnum('type').notNull(),
    filePath: varchar('file_path', { length: 512 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('models_user_active_idx')
      .on(table.userId)
      .where(sql`deleted_at IS NULL`),
  ],
);

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
  (table) => [
    primaryKey({ columns: [table.modelId, table.mediaId] }),
    index('model_inputs_model_id_idx').on(table.modelId),
  ],
);

export const documents = pgTable(
  'documents',
  {
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
    narrativeModeEnabled: boolean('narrative_mode_enabled')
      .default(false)
      .notNull(),
    mediaModeEnabled: boolean('media_mode_enabled').default(false).notNull(),
    currentVersion: integer('current_version').default(0).notNull(),
    lastAnalyzedVersion: integer('last_analyzed_version'),
    analysisStatus: text('analysis_status'),
    analysisStartedAt: timestamp('analysis_started_at', { withTimezone: true }),
    analysisCompletedAt: timestamp('analysis_completed_at', {
      withTimezone: true,
    }),
    analysisCheckpoint: jsonb('analysis_checkpoint'),
    segmentSequence: jsonb('segment_sequence').default([]).notNull(),
    yjsState: text('yjs_state'),
    summary: text('summary'),
    summaryEditChainLength: integer('summary_edit_chain_length')
      .default(0)
      .notNull(),
    summaryUpdatedAt: timestamp('summary_updated_at', { withTimezone: true }),
    layoutPositions:
      jsonb('layout_positions').$type<
        Array<{ nodeId: string; x: number; y: number }>
      >(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('documents_user_id_idx').on(table.userId),
    index('documents_updated_at_idx').on(table.updatedAt),
    index('documents_user_active_idx')
      .on(table.userId, table.deletedAt)
      .where(sql`deleted_at IS NULL`),
  ],
);

export const documentMedia = pgTable(
  'document_media',
  {
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
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('document_media_document_id_idx').on(table.documentId),
    index('document_media_media_id_idx').on(table.mediaId),
    index('document_media_document_active_idx')
      .on(table.documentId)
      .where(sql`deleted_at IS NULL`),
  ],
);

export const documentVersions = pgTable(
  'document_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    yjsState: text('yjs_state').notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('document_versions_unique').on(
      table.documentId,
      table.versionNumber,
    ),
    index('document_versions_lookup_idx').on(
      table.documentId,
      table.versionNumber,
    ),
  ],
);

export const mentionSourceEnum = pgEnum('mention_source', [
  'extraction',
  'name_match',
  'reference',
  'semantic',
]);

export const mentions = pgTable(
  'mentions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    nodeId: varchar('node_id', { length: 255 }).notNull(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    segmentId: varchar('segment_id', { length: 255 }).notNull(),
    facetId: uuid('facet_id'),
    relativeStart: integer('relative_start').notNull(),
    relativeEnd: integer('relative_end').notNull(),
    originalText: text('original_text').notNull(),
    textHash: varchar('text_hash', { length: 64 }).notNull(),
    confidence: integer('confidence').default(100).notNull(),
    versionNumber: integer('version_number').notNull(),
    source: mentionSourceEnum('source').default('extraction').notNull(),
    isKeyPassage: boolean('is_key_passage').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('mentions_node_idx').on(table.nodeId),
    index('mentions_segment_idx').on(table.documentId, table.segmentId),
    index('mentions_version_idx').on(table.documentId, table.versionNumber),
    index('mentions_confidence_idx').on(table.confidence),
    index('mentions_source_idx').on(table.source),
    index('idx_mentions_facet')
      .on(table.facetId)
      .where(sql`facet_id IS NOT NULL`),
  ],
);

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

export const passwordResetTokensRelations = relations(
  passwordResetTokens,
  ({ one }) => ({
    user: one(users, {
      fields: [passwordResetTokens.userId],
      references: [users.id],
    }),
  }),
);

export const emailVerificationTokensRelations = relations(
  emailVerificationTokens,
  ({ one }) => ({
    user: one(users, {
      fields: [emailVerificationTokens.userId],
      references: [users.id],
    }),
  }),
);

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

export const userStylePrompts = pgTable(
  'user_style_prompts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    prompt: text('prompt').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('user_style_prompts_user_id_idx').on(table.userId),
    index('user_style_prompts_user_active_idx')
      .on(table.userId)
      .where(sql`deleted_at IS NULL`),
  ],
);

export const nodeMedia = pgTable(
  'node_media',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    nodeId: varchar('node_id', { length: 255 }).notNull(),
    mediaId: uuid('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('node_media_node_idx')
      .on(table.nodeId)
      .where(sql`deleted_at IS NULL`),
    index('node_media_media_idx')
      .on(table.mediaId)
      .where(sql`deleted_at IS NULL`),
    uniqueIndex('node_media_unique').on(table.nodeId, table.mediaId),
  ],
);

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

export const userStylePromptsRelations = relations(
  userStylePrompts,
  ({ one }) => ({
    user: one(users, {
      fields: [userStylePrompts.userId],
      references: [users.id],
    }),
  }),
);

export const nodeMediaRelations = relations(nodeMedia, ({ one }) => ({
  media: one(media, {
    fields: [nodeMedia.mediaId],
    references: [media.id],
  }),
}));

export const documentVersionsRelations = relations(
  documentVersions,
  ({ one }) => ({
    document: one(documents, {
      fields: [documentVersions.documentId],
      references: [documents.id],
    }),
  }),
);

export const mentionsRelations = relations(mentions, ({ one }) => ({
  document: one(documents, {
    fields: [mentions.documentId],
    references: [documents.id],
  }),
}));

export const sentenceEmbeddings = pgTable(
  'sentence_embeddings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    segmentId: varchar('segment_id', { length: 255 }).notNull(),
    sentenceStart: integer('sentence_start').notNull(),
    sentenceEnd: integer('sentence_end').notNull(),
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    embedding: text('embedding').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_sentence_embeddings_document').on(table.documentId),
    index('idx_sentence_embeddings_segment').on(
      table.documentId,
      table.segmentId,
    ),
    index('idx_sentence_embeddings_hash').on(table.contentHash),
  ],
);

export const sentenceEmbeddingsRelations = relations(
  sentenceEmbeddings,
  ({ one }) => ({
    document: one(documents, {
      fields: [sentenceEmbeddings.documentId],
      references: [documents.id],
    }),
  }),
);

export const analysisSnapshots = pgTable(
  'analysis_snapshots',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    sentenceIndex: integer('sentence_index').notNull(),
    sentenceStart: integer('sentence_start').notNull(),
    sentenceEnd: integer('sentence_end').notNull(),
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_analysis_snapshots_doc_version').on(
      table.documentId,
      table.versionNumber,
    ),
    uniqueIndex('idx_analysis_snapshots_unique').on(
      table.documentId,
      table.versionNumber,
      table.sentenceIndex,
    ),
  ],
);

export const analysisSnapshotsRelations = relations(
  analysisSnapshots,
  ({ one }) => ({
    document: one(documents, {
      fields: [analysisSnapshots.documentId],
      references: [documents.id],
    }),
  }),
);

// Review queue for user review of LLM-detected conflicts
// Per TDD 2026-02-21 Section 7.3

export const reviewItemTypeEnum = pgEnum('review_item_type', [
  'contradiction',
  'merge_suggestion',
  'gap_detected',
  'low_confidence',
]);

export const reviewQueue = pgTable(
  'review_queue',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    itemType: reviewItemTypeEnum('item_type').notNull(),

    primaryEntityId: varchar('primary_entity_id', { length: 255 }),
    secondaryEntityId: varchar('secondary_entity_id', { length: 255 }),
    facetIds: text('facet_ids').array(),
    stateIds: text('state_ids').array(),

    contextSummary: text('context_summary').notNull(),
    sourcePositions: jsonb('source_positions'),
    conflictType: varchar('conflict_type', { length: 50 }),
    similarity: integer('similarity'),

    status: varchar('status', { length: 20 }).default('pending').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => users.id),
    resolution: jsonb('resolution'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_review_queue_document').on(
      table.documentId,
      table.status,
      table.createdAt,
    ),
    index('idx_review_queue_status').on(table.status),
    index('idx_review_queue_entity').on(table.primaryEntityId),
  ],
);

export const reviewQueueRelations = relations(reviewQueue, ({ one }) => ({
  document: one(documents, {
    fields: [reviewQueue.documentId],
    references: [documents.id],
  }),
  resolvedByUser: one(users, {
    fields: [reviewQueue.resolvedBy],
    references: [users.id],
  }),
}));

export const llmUsage = pgTable(
  'llm_usage',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id').references(() => documents.id, {
      onDelete: 'cascade',
    }),
    requestId: uuid('request_id'),
    operation: varchar('operation', { length: 100 }).notNull(),
    model: varchar('model', { length: 50 })
      .notNull()
      .default('gemini-2.0-flash'),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    costUsd: decimal('cost_usd', { precision: 10, scale: 6 }).notNull(),
    durationMs: integer('duration_ms'),
    stage: integer('stage'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('llm_usage_user_date_idx').on(table.userId, table.createdAt),
    index('llm_usage_date_idx').on(table.createdAt),
    index('llm_usage_request_idx').on(table.requestId),
    index('llm_usage_document_idx').on(table.documentId),
  ],
);

export const llmUsageDaily = pgTable(
  'llm_usage_daily',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    totalOperations: integer('total_operations').notNull(),
    totalInputTokens: bigint('total_input_tokens', {
      mode: 'number',
    }).notNull(),
    totalOutputTokens: bigint('total_output_tokens', {
      mode: 'number',
    }).notNull(),
    totalCostUsd: decimal('total_cost_usd', {
      precision: 12,
      scale: 6,
    }).notNull(),
    operationBreakdown: jsonb('operation_breakdown'),
    modelBreakdown: jsonb('model_breakdown'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('llm_usage_daily_unique').on(table.userId, table.date),
    index('llm_usage_daily_date_idx').on(table.date),
    index('llm_usage_daily_user_idx').on(table.userId),
  ],
);

export const userSubscriptions = pgTable(
  'user_subscriptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tier: varchar('tier', { length: 20 }).notNull().default('free'),
    grantType: varchar('grant_type', { length: 50 })
      .notNull()
      .default('standard'),
    usageQuota: integer('usage_quota').notNull(),
    usageConsumed: integer('usage_consumed').notNull().default(0),
    periodStart: timestamp('period_start', { withTimezone: true })
      .notNull()
      .defaultNow(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    trialRequestedAt: timestamp('trial_requested_at', { withTimezone: true }),
    trialApprovedAt: timestamp('trial_approved_at', { withTimezone: true }),
    trialApprovedBy: uuid('trial_approved_by').references(() => users.id),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_user_subscriptions_user').on(table.userId),
    index('idx_user_subscriptions_period_end').on(table.periodEnd),
    index('idx_user_subscriptions_tier').on(table.tier),
    uniqueIndex('user_subscriptions_user_unique').on(table.userId),
  ],
);

export const contactSubmissions = pgTable(
  'contact_submissions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    email: varchar('email', { length: 255 }).notNull(),
    subject: varchar('subject', { length: 255 }).notNull(),
    message: text('message').notNull(),
    submissionType: varchar('submission_type', { length: 50 })
      .notNull()
      .default('contact'),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    respondedBy: uuid('responded_by').references(() => users.id),
    adminNotes: text('admin_notes'),
    userAgent: text('user_agent'),
    ipAddress: varchar('ip_address', { length: 45 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_contact_submissions_status').on(table.status, table.createdAt),
    index('idx_contact_submissions_user').on(table.userId),
    index('idx_contact_submissions_type').on(table.submissionType),
  ],
);

export const pricingAuditLog = pgTable(
  'pricing_audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    changeType: varchar('change_type', { length: 50 }).notNull(),
    entityType: varchar('entity_type', { length: 50 }).notNull(),
    entityId: varchar('entity_id', { length: 100 }).notNull(),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value').notNull(),
    changedBy: uuid('changed_by')
      .notNull()
      .references(() => users.id),
    reason: text('reason').notNull(),
    gitCommit: varchar('git_commit', { length: 40 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_pricing_audit_log_date').on(table.createdAt),
    index('idx_pricing_audit_log_entity').on(table.entityType, table.entityId),
    index('idx_pricing_audit_log_changed_by').on(table.changedBy),
  ],
);

export const quotaReservations = pgTable(
  'quota_reservations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    operationId: uuid('operation_id').notNull().unique(),
    amount: integer('amount').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`NOW() + INTERVAL '5 minutes'`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_quota_reservations_user_active').on(
      table.userId,
      table.expiresAt,
    ),
    index('idx_quota_reservations_expires').on(table.expiresAt),
  ],
);

export const changeSourceEnum = pgEnum('change_source', ['user', 'system']);

export const changeLog = pgTable(
  'change_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    source: changeSourceEnum('source').notNull(),
    targetType: varchar('target_type', { length: 30 }).notNull(),
    targetId: varchar('target_id', { length: 255 }).notNull(),
    operation: varchar('operation', { length: 20 }).notNull(),
    relatedEntityIds: text('related_entity_ids').array().notNull().default([]),
    summary: text('summary').notNull(),
    changeData: jsonb('change_data').notNull(),
    reason: text('reason'),
    sourcePosition: integer('source_position'),
    batchId: uuid('batch_id'),
  },
  (table) => [
    index('idx_change_log_target').on(table.targetType, table.targetId),
    index('idx_change_log_batch').on(table.batchId),
  ],
);

// Job queue for unified background processing
export const jobStatusEnum = pgEnum('job_status', [
  'queued',
  'processing',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);

export const jobTypeEnum = pgEnum('job_type', [
  'document_analysis',
  'prompt_augmentation',
  'thumbnail_generation',
  'media_status_update',
  'pdf_export',
]);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    type: jobTypeEnum('type').notNull(),
    status: jobStatusEnum('status').notNull().default('queued'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetType: varchar('target_type', { length: 30 }).notNull(),
    targetId: uuid('target_id').notNull(),
    payload: jsonb('payload').notNull().default({}),
    progress: jsonb('progress'),
    progressUpdatedAt: timestamp('progress_updated_at', { withTimezone: true }),
    checkpoint: jsonb('checkpoint'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    errorMessage: text('error_message'),
    retryCount: integer('retry_count').notNull().default(0),
    maxRetries: integer('max_retries').notNull().default(3),
    workerId: varchar('worker_id', { length: 100 }),
  },
  (table) => [
    index('idx_jobs_queue')
      .on(table.type, table.status, table.createdAt)
      .where(sql`status IN ('queued', 'paused')`),
    index('idx_jobs_target').on(table.targetType, table.targetId),
    index('idx_jobs_user').on(table.userId, table.createdAt),
    index('idx_jobs_stale')
      .on(table.status, table.startedAt, table.progressUpdatedAt)
      .where(sql`status = 'processing'`),
  ],
);

export const jobsRelations = relations(jobs, ({ one }) => ({
  user: one(users, {
    fields: [jobs.userId],
    references: [users.id],
  }),
}));
