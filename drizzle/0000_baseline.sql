-- Migration: 0000_baseline
-- Generated: 2026-03-11 from local dev database (31 tables, PostgreSQL 16.3)
-- Source: pg_dump --schema-only --no-owner --no-acl
-- Rollback: Cannot rollback baseline - drop database and recreate empty

--
-- PostgreSQL database dump
--

-- Dumped from database version 16.3 (Postgres.app)
-- Dumped by pg_dump version 16.3 (Postgres.app)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: activity_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.activity_status AS ENUM (
    'pending',
    'running',
    'completed',
    'failed',
    'cancelled'
);


--
-- Name: activity_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.activity_type AS ENUM (
    'image_generation',
    'document_analysis',
    'pdf_export',
    'docx_export',
    'txt_export',
    'md_export',
    'drive_import',
    'drive_export'
);


--
-- Name: change_source; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.change_source AS ENUM (
    'user',
    'system'
);


--
-- Name: grant_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.grant_type AS ENUM (
    'standard',
    'test_grant',
    'trial_approved',
    'paid'
);


--
-- Name: job_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.job_status AS ENUM (
    'queued',
    'processing',
    'paused',
    'completed',
    'failed',
    'cancelled'
);


--
-- Name: job_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.job_type AS ENUM (
    'document_analysis',
    'prompt_augmentation',
    'thumbnail_generation',
    'media_status_update',
    'pdf_export',
    'docx_export',
    'image_generation'
);


--
-- Name: media_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.media_status AS ENUM (
    'queued',
    'augmenting',
    'processing',
    'completed',
    'failed'
);


--
-- Name: mention_source; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.mention_source AS ENUM (
    'extraction',
    'name_match',
    'reference',
    'semantic'
);


--
-- Name: model_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.model_type AS ENUM (
    'lora',
    'checkpoint',
    'other'
);


--
-- Name: review_item_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.review_item_type AS ENUM (
    'contradiction',
    'merge_suggestion',
    'gap_detected',
    'low_confidence'
);


--
-- Name: source_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.source_type AS ENUM (
    'upload',
    'generation'
);


--
-- Name: story_node_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.story_node_type AS ENUM (
    'character',
    'location',
    'event',
    'other'
);


--
-- Name: submission_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.submission_status AS ENUM (
    'pending',
    'responded',
    'resolved'
);


--
-- Name: submission_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.submission_type AS ENUM (
    'contact',
    'trial_request',
    'bug_report',
    'feedback'
);


--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_role AS ENUM (
    'user',
    'admin'
);


--
-- Name: user_tier; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_tier AS ENUM (
    'free',
    'pro',
    'max',
    'admin'
);


--
-- Name: cleanup_expired_reservations(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_expired_reservations() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM quota_reservations WHERE expires_at < NOW();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;


--
-- Name: set_initial_period_end(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_initial_period_end() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.period_start := date_trunc('hour', NEW.period_start) + INTERVAL '1 hour';
  NEW.period_end := NEW.period_start + INTERVAL '1 month';
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    activity_type public.activity_type NOT NULL,
    status public.activity_status DEFAULT 'pending'::public.activity_status NOT NULL,
    target_type character varying(30) NOT NULL,
    target_id uuid NOT NULL,
    job_id uuid,
    media_id uuid,
    title character varying(255) NOT NULL,
    progress jsonb,
    result_url character varying(512),
    error_message text,
    viewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: analysis_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analysis_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    version_number integer NOT NULL,
    sentence_index integer NOT NULL,
    sentence_start integer NOT NULL,
    sentence_end integer NOT NULL,
    content_hash character varying(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: change_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.change_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source public.change_source NOT NULL,
    target_type character varying(30) NOT NULL,
    target_id character varying(255) NOT NULL,
    operation character varying(20) NOT NULL,
    related_entity_ids character varying(255)[] DEFAULT '{}'::character varying[] NOT NULL,
    summary text NOT NULL,
    change_data jsonb NOT NULL,
    reason text,
    source_position integer,
    batch_id uuid,
    CONSTRAINT valid_operation CHECK (((operation)::text = ANY ((ARRAY['create'::character varying, 'update'::character varying, 'delete'::character varying, 'merge'::character varying])::text[]))),
    CONSTRAINT valid_target_type CHECK (((target_type)::text = ANY ((ARRAY['entity'::character varying, 'facet'::character varying, 'edge'::character varying, 'mention'::character varying, 'character_state'::character varying, 'arc'::character varying, 'thread'::character varying])::text[])))
);


--
-- Name: TABLE change_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.change_log IS 'Immutable audit trail for all graph and mention operations';


--
-- Name: COLUMN change_log.related_entity_ids; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.change_log.related_entity_ids IS 'Entity IDs affected by this change, for efficient entity-centric queries';


--
-- Name: COLUMN change_log.summary; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.change_log.summary IS 'Human-readable summary generated at write time';


--
-- Name: COLUMN change_log.change_data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.change_log.change_data IS 'Full before/after content as JSONB';


--
-- Name: COLUMN change_log.reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.change_log.reason IS 'LLM reasoning for system-generated changes';


--
-- Name: COLUMN change_log.batch_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.change_log.batch_id IS 'Groups related changes from same operation (merge, extraction batch)';


--
-- Name: contact_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    email character varying(255) NOT NULL,
    subject character varying(255) NOT NULL,
    message text NOT NULL,
    submission_type public.submission_type DEFAULT 'contact'::public.submission_type NOT NULL,
    status public.submission_status DEFAULT 'pending'::public.submission_status NOT NULL,
    responded_at timestamp with time zone,
    responded_by uuid,
    admin_notes text,
    user_agent text,
    ip_address character varying(45),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: document_media; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_media (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    media_id uuid NOT NULL,
    start_char integer,
    end_char integer,
    node_pos integer,
    text_offset integer,
    source_text text,
    context_before text,
    context_after text,
    requested_prompt text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: document_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    version_number integer NOT NULL,
    yjs_state text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    title character varying(100) NOT NULL,
    content text NOT NULL,
    content_json jsonb,
    default_style_preset character varying(50),
    default_style_prompt text,
    default_image_width integer DEFAULT 1024,
    default_image_height integer DEFAULT 1024,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    narrative_mode_enabled boolean DEFAULT false NOT NULL,
    media_mode_enabled boolean DEFAULT false NOT NULL,
    current_version integer DEFAULT 0 NOT NULL,
    segment_sequence jsonb DEFAULT '[]'::jsonb NOT NULL,
    yjs_state text,
    last_analyzed_version integer,
    analysis_status text,
    analysis_started_at timestamp without time zone,
    analysis_checkpoint jsonb,
    summary text,
    summary_edit_chain_length integer DEFAULT 0 NOT NULL,
    summary_updated_at timestamp with time zone,
    analysis_completed_at timestamp with time zone,
    layout_positions jsonb
);


--
-- Name: COLUMN documents.summary; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.documents.summary IS 'LLM-generated document summary, updated progressively via diffs';


--
-- Name: COLUMN documents.summary_edit_chain_length; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.documents.summary_edit_chain_length IS 'Number of edit updates since last full regeneration (reset at 10)';


--
-- Name: COLUMN documents.summary_updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.documents.summary_updated_at IS 'When summary was last updated';


--
-- Name: COLUMN documents.analysis_completed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.documents.analysis_completed_at IS 'Timestamp when analysis successfully completed (null if failed/incomplete)';


--
-- Name: COLUMN documents.layout_positions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.documents.layout_positions IS 'Cached 2D projection coordinates for graph visualization. NULL means needs recomputation.';


--
-- Name: email_verification_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_verification_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token character varying(255) NOT NULL,
    email character varying(255) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: image_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    media_id uuid,
    provider character varying(50) NOT NULL,
    cost_usd numeric(12,6) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: image_usage_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_usage_daily (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    date date NOT NULL,
    total_operations integer NOT NULL,
    total_cost_usd numeric(12,6) NOT NULL,
    provider_breakdown jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type public.job_type NOT NULL,
    status public.job_status DEFAULT 'queued'::public.job_status NOT NULL,
    user_id uuid NOT NULL,
    target_type character varying(30) NOT NULL,
    target_id uuid NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    progress jsonb,
    progress_updated_at timestamp with time zone,
    checkpoint jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    error_message text,
    retry_count integer DEFAULT 0 NOT NULL,
    max_retries integer DEFAULT 3 NOT NULL,
    worker_id character varying(100)
);


--
-- Name: llm_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.llm_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    document_id uuid,
    request_id uuid,
    operation character varying(100) NOT NULL,
    model character varying(50) DEFAULT 'gemini-2.0-flash'::character varying NOT NULL,
    input_tokens integer NOT NULL,
    output_tokens integer NOT NULL,
    cost_usd numeric(10,6) NOT NULL,
    duration_ms integer,
    stage integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: llm_usage_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.llm_usage_daily (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    date date NOT NULL,
    total_operations integer NOT NULL,
    total_input_tokens bigint NOT NULL,
    total_output_tokens bigint NOT NULL,
    total_cost_usd numeric(12,6) NOT NULL,
    operation_breakdown jsonb,
    model_breakdown jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: media; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    source_type public.source_type DEFAULT 'upload'::public.source_type NOT NULL,
    status public.media_status DEFAULT 'completed'::public.media_status NOT NULL,
    storage_key character varying(512),
    s3_key character varying(512),
    s3_key_thumb character varying(512),
    s3_bucket character varying(255),
    size integer,
    mime_type character varying(100),
    hash character varying(64),
    width integer,
    height integer,
    prompt text,
    style_preset character varying(50),
    style_prompt text,
    seed integer,
    error text,
    attempts integer DEFAULT 0 NOT NULL,
    cancelled_at timestamp with time zone,
    generated boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    media_role character varying(20),
    generation_settings jsonb,
    generation_settings_schema_version integer
);


--
-- Name: media_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_tags (
    media_id uuid NOT NULL,
    tag_id uuid NOT NULL
);


--
-- Name: mentions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mentions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    node_id character varying(255) NOT NULL,
    document_id uuid NOT NULL,
    segment_id character varying(255) NOT NULL,
    relative_start integer NOT NULL,
    relative_end integer NOT NULL,
    original_text text NOT NULL,
    text_hash character varying(64) NOT NULL,
    confidence integer DEFAULT 100 NOT NULL,
    version_number integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source public.mention_source DEFAULT 'extraction'::public.mention_source NOT NULL,
    is_key_passage boolean DEFAULT false NOT NULL,
    facet_id uuid
);


--
-- Name: model_inputs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_inputs (
    model_id uuid NOT NULL,
    media_id uuid NOT NULL
);


--
-- Name: models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.models (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    type public.model_type NOT NULL,
    file_path character varying(512) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: node_media; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.node_media (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    node_id uuid NOT NULL,
    media_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token character varying(255) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: pricing_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pricing_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    change_type character varying(50) NOT NULL,
    entity_type character varying(50) NOT NULL,
    entity_id character varying(100) NOT NULL,
    old_value jsonb,
    new_value jsonb NOT NULL,
    changed_by uuid NOT NULL,
    reason text NOT NULL,
    git_commit character varying(40),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: quota_reservations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quota_reservations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    amount integer NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:05:00'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: review_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.review_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    item_type public.review_item_type NOT NULL,
    primary_entity_id character varying(255),
    secondary_entity_id character varying(255),
    facet_ids character varying(255)[],
    state_ids character varying(255)[],
    context_summary text NOT NULL,
    source_positions jsonb,
    conflict_type character varying(50),
    similarity real,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    resolution jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--

--
-- Name: sentence_embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sentence_embeddings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    segment_id character varying(255) NOT NULL,
    sentence_start integer NOT NULL,
    sentence_end integer NOT NULL,
    content_hash character varying(64) NOT NULL,
    embedding public.vector(1536) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token character varying(255) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_activity_at timestamp with time zone,
    ip_address character varying(45),
    user_agent text
);


--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_style_prompts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_style_prompts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    prompt text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: user_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    tier public.user_tier DEFAULT 'free'::public.user_tier NOT NULL,
    grant_type public.grant_type DEFAULT 'standard'::public.grant_type NOT NULL,
    usage_quota integer NOT NULL,
    usage_consumed integer DEFAULT 0 NOT NULL,
    period_start timestamp with time zone DEFAULT now() NOT NULL,
    period_end timestamp with time zone NOT NULL,
    trial_requested_at timestamp with time zone,
    trial_approved_at timestamp with time zone,
    trial_approved_by uuid,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT positive_quota CHECK ((usage_quota > 0)),
    CONSTRAINT valid_consumption CHECK ((usage_consumed >= 0)),
    CONSTRAINT valid_period CHECK ((period_end > period_start))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    username character varying(50) NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255),
    oauth_provider character varying(50),
    oauth_provider_id character varying(255),
    role public.user_role DEFAULT 'user'::public.user_role NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    pending_email character varying(255),
    default_image_width integer DEFAULT 1024,
    default_image_height integer DEFAULT 1024,
    default_style_preset character varying(50),
    hidden_preset_ids text[],
    failed_login_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    node_type_style_defaults jsonb,
    google_access_token text,
    google_refresh_token text,
    google_token_expiry timestamp with time zone,
    google_token_iv character varying(32),
    google_token_tag character varying(32),
    deleted_at timestamp with time zone,
    scheduled_deletion_at timestamp with time zone
);


--
-- Name: COLUMN users.google_access_token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.google_access_token IS 'Encrypted Google OAuth access token';


--
-- Name: COLUMN users.google_refresh_token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.google_refresh_token IS 'Encrypted Google OAuth refresh token';


--
-- Name: COLUMN users.google_token_expiry; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.google_token_expiry IS 'When the access token expires';


--
-- Name: COLUMN users.google_token_iv; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.google_token_iv IS 'AES-GCM initialization vector (hex)';


--
-- Name: COLUMN users.google_token_tag; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.google_token_tag IS 'AES-GCM authentication tag (hex)';


--
-- Name: activities activities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_pkey PRIMARY KEY (id);


--
-- Name: analysis_snapshots analysis_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_snapshots
    ADD CONSTRAINT analysis_snapshots_pkey PRIMARY KEY (id);


--
-- Name: change_log change_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.change_log
    ADD CONSTRAINT change_log_pkey PRIMARY KEY (id);


--
-- Name: contact_submissions contact_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_submissions
    ADD CONSTRAINT contact_submissions_pkey PRIMARY KEY (id);


--
-- Name: document_media document_media_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_media
    ADD CONSTRAINT document_media_pkey PRIMARY KEY (id);


--
-- Name: document_versions document_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_pkey PRIMARY KEY (id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: email_verification_tokens email_verification_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_pkey PRIMARY KEY (id);


--
-- Name: email_verification_tokens email_verification_tokens_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_token_unique UNIQUE (token);


--
-- Name: image_usage_daily image_usage_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_usage_daily
    ADD CONSTRAINT image_usage_daily_pkey PRIMARY KEY (id);


--
-- Name: image_usage_daily image_usage_daily_user_id_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_usage_daily
    ADD CONSTRAINT image_usage_daily_user_id_date_key UNIQUE (user_id, date);


--
-- Name: image_usage image_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_usage
    ADD CONSTRAINT image_usage_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: llm_usage_daily llm_usage_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_usage_daily
    ADD CONSTRAINT llm_usage_daily_pkey PRIMARY KEY (id);


--
-- Name: llm_usage_daily llm_usage_daily_user_id_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_usage_daily
    ADD CONSTRAINT llm_usage_daily_user_id_date_key UNIQUE (user_id, date);


--
-- Name: llm_usage llm_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_usage
    ADD CONSTRAINT llm_usage_pkey PRIMARY KEY (id);


--
-- Name: media media_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media
    ADD CONSTRAINT media_pkey PRIMARY KEY (id);


--
-- Name: media_tags media_tags_media_id_tag_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_tags
    ADD CONSTRAINT media_tags_media_id_tag_id_pk PRIMARY KEY (media_id, tag_id);


--
-- Name: mentions mentions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mentions
    ADD CONSTRAINT mentions_pkey PRIMARY KEY (id);


--
-- Name: model_inputs model_inputs_model_id_media_id_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_inputs
    ADD CONSTRAINT model_inputs_model_id_media_id_pk PRIMARY KEY (model_id, media_id);


--
-- Name: models models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.models
    ADD CONSTRAINT models_pkey PRIMARY KEY (id);


--
-- Name: node_media node_media_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_media
    ADD CONSTRAINT node_media_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_token_unique UNIQUE (token);


--
-- Name: pricing_audit_log pricing_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_audit_log
    ADD CONSTRAINT pricing_audit_log_pkey PRIMARY KEY (id);


--
-- Name: quota_reservations quota_reservations_operation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quota_reservations
    ADD CONSTRAINT quota_reservations_operation_id_key UNIQUE (operation_id);


--
-- Name: quota_reservations quota_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quota_reservations
    ADD CONSTRAINT quota_reservations_pkey PRIMARY KEY (id);


--
-- Name: review_queue review_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_queue
    ADD CONSTRAINT review_queue_pkey PRIMARY KEY (id);


--
--
-- Name: sentence_embeddings sentence_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sentence_embeddings
    ADD CONSTRAINT sentence_embeddings_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_token_unique UNIQUE (token);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: user_style_prompts user_style_prompts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_style_prompts
    ADD CONSTRAINT user_style_prompts_pkey PRIMARY KEY (id);


--
-- Name: user_subscriptions user_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_subscriptions
    ADD CONSTRAINT user_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: user_subscriptions user_subscriptions_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_subscriptions
    ADD CONSTRAINT user_subscriptions_user_id_key UNIQUE (user_id);


--
-- Name: users users_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_unique UNIQUE (username);


--
-- Name: document_media_document_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_media_document_active_idx ON public.document_media USING btree (document_id) WHERE (deleted_at IS NULL);


--
-- Name: document_media_document_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_media_document_id_idx ON public.document_media USING btree (document_id);


--
-- Name: document_media_media_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_media_media_id_idx ON public.document_media USING btree (media_id);


--
-- Name: document_versions_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX document_versions_lookup_idx ON public.document_versions USING btree (document_id, version_number);


--
-- Name: document_versions_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX document_versions_unique ON public.document_versions USING btree (document_id, version_number);


--
-- Name: documents_analysis_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_analysis_state_idx ON public.documents USING btree (last_analyzed_version, current_version);


--
-- Name: documents_updated_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_updated_at_idx ON public.documents USING btree (updated_at);


--
-- Name: documents_user_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_user_active_idx ON public.documents USING btree (user_id, deleted_at) WHERE (deleted_at IS NULL);


--
-- Name: documents_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX documents_user_id_idx ON public.documents USING btree (user_id);


--
-- Name: email_verification_tokens_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_verification_tokens_token_idx ON public.email_verification_tokens USING btree (token);


--
-- Name: email_verification_tokens_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_verification_tokens_user_id_idx ON public.email_verification_tokens USING btree (user_id);


--
-- Name: idx_activities_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activities_job ON public.activities USING btree (job_id) WHERE (job_id IS NOT NULL);


--
-- Name: idx_activities_media; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activities_media ON public.activities USING btree (media_id) WHERE (media_id IS NOT NULL);


--
-- Name: idx_activities_unviewed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activities_unviewed ON public.activities USING btree (user_id) WHERE (viewed_at IS NULL);


--
-- Name: idx_activities_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activities_user ON public.activities USING btree (user_id, created_at DESC);


--
-- Name: idx_activities_user_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activities_user_active ON public.activities USING btree (user_id, status) WHERE (status = ANY (ARRAY['pending'::public.activity_status, 'running'::public.activity_status]));


--
-- Name: idx_analysis_snapshots_doc_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_analysis_snapshots_doc_version ON public.analysis_snapshots USING btree (document_id, version_number);


--
-- Name: idx_analysis_snapshots_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_analysis_snapshots_unique ON public.analysis_snapshots USING btree (document_id, version_number, sentence_index);


--
-- Name: idx_change_log_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_change_log_batch ON public.change_log USING btree (batch_id) WHERE (batch_id IS NOT NULL);


--
-- Name: idx_change_log_entities; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_change_log_entities ON public.change_log USING gin (related_entity_ids);


--
-- Name: idx_change_log_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_change_log_target ON public.change_log USING btree (target_type, target_id);


--
-- Name: idx_change_log_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_change_log_time ON public.change_log USING brin (created_at);


--
-- Name: idx_contact_submissions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_submissions_status ON public.contact_submissions USING btree (status, created_at DESC);


--
-- Name: idx_contact_submissions_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_submissions_type ON public.contact_submissions USING btree (submission_type);


--
-- Name: idx_contact_submissions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contact_submissions_user ON public.contact_submissions USING btree (user_id);


--
-- Name: idx_documents_summary_chain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_summary_chain ON public.documents USING btree (summary_edit_chain_length) WHERE (summary_edit_chain_length >= 10);


--
-- Name: idx_image_usage_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_image_usage_created_at ON public.image_usage USING btree (created_at);


--
-- Name: idx_image_usage_daily_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_image_usage_daily_date ON public.image_usage_daily USING btree (date);


--
-- Name: idx_image_usage_daily_user_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_image_usage_daily_user_date ON public.image_usage_daily USING btree (user_id, date);


--
-- Name: idx_image_usage_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_image_usage_user_id ON public.image_usage USING btree (user_id);


--
-- Name: idx_jobs_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_jobs_active ON public.jobs USING btree (type, target_id) WHERE (status = ANY (ARRAY['queued'::public.job_status, 'processing'::public.job_status, 'paused'::public.job_status]));


--
-- Name: idx_jobs_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_queue ON public.jobs USING btree (type, status, created_at) WHERE (status = ANY (ARRAY['queued'::public.job_status, 'paused'::public.job_status]));


--
-- Name: idx_jobs_stale; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_stale ON public.jobs USING btree (status, started_at, progress_updated_at) WHERE (status = 'processing'::public.job_status);


--
-- Name: idx_jobs_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_target ON public.jobs USING btree (target_type, target_id);


--
-- Name: idx_jobs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_user ON public.jobs USING btree (user_id, created_at DESC);


--
-- Name: idx_mentions_facet; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mentions_facet ON public.mentions USING btree (facet_id) WHERE (facet_id IS NOT NULL);


--
-- Name: idx_pricing_audit_log_changed_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pricing_audit_log_changed_by ON public.pricing_audit_log USING btree (changed_by);


--
-- Name: idx_pricing_audit_log_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pricing_audit_log_date ON public.pricing_audit_log USING btree (created_at DESC);


--
-- Name: idx_pricing_audit_log_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pricing_audit_log_entity ON public.pricing_audit_log USING btree (entity_type, entity_id);


--
-- Name: idx_quota_reservations_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quota_reservations_expires ON public.quota_reservations USING btree (expires_at);


--
-- Name: idx_quota_reservations_user_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quota_reservations_user_active ON public.quota_reservations USING btree (user_id, expires_at);


--
-- Name: idx_review_queue_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_review_queue_document ON public.review_queue USING btree (document_id, status, created_at DESC);


--
-- Name: idx_review_queue_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_review_queue_entity ON public.review_queue USING btree (primary_entity_id) WHERE (primary_entity_id IS NOT NULL);


--
-- Name: idx_review_queue_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_review_queue_status ON public.review_queue USING btree (status) WHERE ((status)::text = 'pending'::text);


--
-- Name: idx_sentence_embeddings_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sentence_embeddings_document ON public.sentence_embeddings USING btree (document_id);


--
-- Name: idx_sentence_embeddings_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sentence_embeddings_hash ON public.sentence_embeddings USING btree (content_hash);


--
-- Name: idx_sentence_embeddings_segment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sentence_embeddings_segment ON public.sentence_embeddings USING btree (document_id, segment_id);


--
-- Name: idx_sentence_embeddings_vector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sentence_embeddings_vector ON public.sentence_embeddings USING hnsw (embedding public.vector_cosine_ops) WITH (m='16', ef_construction='64');


--
-- Name: idx_user_subscriptions_period_end; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_subscriptions_period_end ON public.user_subscriptions USING btree (period_end) WHERE (cancelled_at IS NULL);


--
-- Name: idx_user_subscriptions_tier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_subscriptions_tier ON public.user_subscriptions USING btree (tier);


--
-- Name: idx_user_subscriptions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_subscriptions_user ON public.user_subscriptions USING btree (user_id);


--
-- Name: llm_usage_daily_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX llm_usage_daily_date_idx ON public.llm_usage_daily USING btree (date);


--
-- Name: llm_usage_daily_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX llm_usage_daily_unique ON public.llm_usage_daily USING btree (user_id, date);


--
-- Name: llm_usage_daily_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX llm_usage_daily_user_idx ON public.llm_usage_daily USING btree (user_id);


--
-- Name: llm_usage_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX llm_usage_date_idx ON public.llm_usage USING btree (created_at);


--
-- Name: llm_usage_document_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX llm_usage_document_idx ON public.llm_usage USING btree (document_id);


--
-- Name: llm_usage_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX llm_usage_request_idx ON public.llm_usage USING btree (request_id);


--
-- Name: llm_usage_user_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX llm_usage_user_date_idx ON public.llm_usage USING btree (user_id, created_at);


--
-- Name: media_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_created_at_idx ON public.media USING btree (created_at);


--
-- Name: media_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_hash_idx ON public.media USING btree (hash);


--
-- Name: media_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_role_idx ON public.media USING btree (media_role) WHERE (media_role IS NOT NULL);


--
-- Name: media_s3_key_thumb_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_s3_key_thumb_idx ON public.media USING btree (s3_key_thumb) WHERE (s3_key_thumb IS NOT NULL);


--
-- Name: media_source_type_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_source_type_status_idx ON public.media USING btree (source_type, status);


--
-- Name: media_tags_tag_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_tags_tag_id_idx ON public.media_tags USING btree (tag_id);


--
-- Name: media_user_created_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_user_created_active_idx ON public.media USING btree (user_id, created_at) WHERE (deleted_at IS NULL);


--
-- Name: media_user_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_user_created_idx ON public.media USING btree (user_id, created_at);


--
-- Name: media_user_hash_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_user_hash_active_idx ON public.media USING btree (user_id, hash) WHERE (deleted_at IS NULL);


--
-- Name: media_user_hash_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX media_user_hash_unique ON public.media USING btree (user_id, hash) WHERE (deleted_at IS NULL);


--
-- Name: media_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_user_id_idx ON public.media USING btree (user_id);


--
-- Name: media_user_source_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_user_source_type_idx ON public.media USING btree (user_id, source_type);


--
-- Name: mentions_confidence_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mentions_confidence_idx ON public.mentions USING btree (confidence);


--
-- Name: mentions_node_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mentions_node_idx ON public.mentions USING btree (node_id);


--
-- Name: mentions_segment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mentions_segment_idx ON public.mentions USING btree (document_id, segment_id);


--
-- Name: mentions_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mentions_source_idx ON public.mentions USING btree (source);


--
-- Name: mentions_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mentions_version_idx ON public.mentions USING btree (document_id, version_number);


--
-- Name: model_inputs_model_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX model_inputs_model_id_idx ON public.model_inputs USING btree (model_id);


--
-- Name: models_user_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX models_user_active_idx ON public.models USING btree (user_id) WHERE (deleted_at IS NULL);


--
-- Name: node_media_media_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX node_media_media_idx ON public.node_media USING btree (media_id) WHERE (deleted_at IS NULL);


--
-- Name: node_media_node_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX node_media_node_idx ON public.node_media USING btree (node_id) WHERE (deleted_at IS NULL);


--
-- Name: node_media_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX node_media_unique ON public.node_media USING btree (node_id, media_id);


--
-- Name: password_reset_tokens_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX password_reset_tokens_token_idx ON public.password_reset_tokens USING btree (token);


--
-- Name: sessions_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_token_idx ON public.sessions USING btree (token);


--
-- Name: sessions_user_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_expires_idx ON public.sessions USING btree (user_id, expires_at);


--
-- Name: user_style_prompts_user_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_style_prompts_user_active_idx ON public.user_style_prompts USING btree (user_id) WHERE (deleted_at IS NULL);


--
-- Name: user_style_prompts_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_style_prompts_user_id_idx ON public.user_style_prompts USING btree (user_id);


--
-- Name: users_scheduled_deletion_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_scheduled_deletion_idx ON public.users USING btree (scheduled_deletion_at) WHERE (scheduled_deletion_at IS NOT NULL);


--
-- Name: user_subscriptions trigger_set_initial_period_end; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_set_initial_period_end BEFORE INSERT ON public.user_subscriptions FOR EACH ROW EXECUTE FUNCTION public.set_initial_period_end();


--
-- Name: activities activities_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;


--
-- Name: activities activities_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id) ON DELETE SET NULL;


--
-- Name: activities activities_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: analysis_snapshots analysis_snapshots_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analysis_snapshots
    ADD CONSTRAINT analysis_snapshots_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: contact_submissions contact_submissions_responded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_submissions
    ADD CONSTRAINT contact_submissions_responded_by_fkey FOREIGN KEY (responded_by) REFERENCES public.users(id);


--
-- Name: contact_submissions contact_submissions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_submissions
    ADD CONSTRAINT contact_submissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: document_media document_media_document_id_documents_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_media
    ADD CONSTRAINT document_media_document_id_documents_id_fk FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: document_media document_media_media_id_media_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_media
    ADD CONSTRAINT document_media_media_id_media_id_fk FOREIGN KEY (media_id) REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: document_versions document_versions_document_id_documents_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_versions
    ADD CONSTRAINT document_versions_document_id_documents_id_fk FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: documents documents_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: email_verification_tokens email_verification_tokens_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: image_usage_daily image_usage_daily_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_usage_daily
    ADD CONSTRAINT image_usage_daily_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: image_usage image_usage_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_usage
    ADD CONSTRAINT image_usage_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id) ON DELETE SET NULL;


--
-- Name: image_usage image_usage_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_usage
    ADD CONSTRAINT image_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: jobs jobs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: llm_usage_daily llm_usage_daily_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_usage_daily
    ADD CONSTRAINT llm_usage_daily_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: llm_usage llm_usage_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_usage
    ADD CONSTRAINT llm_usage_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: llm_usage llm_usage_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_usage
    ADD CONSTRAINT llm_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: media_tags media_tags_media_id_media_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_tags
    ADD CONSTRAINT media_tags_media_id_media_id_fk FOREIGN KEY (media_id) REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: media_tags media_tags_tag_id_tags_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_tags
    ADD CONSTRAINT media_tags_tag_id_tags_id_fk FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;


--
-- Name: media media_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media
    ADD CONSTRAINT media_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: mentions mentions_document_id_documents_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mentions
    ADD CONSTRAINT mentions_document_id_documents_id_fk FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: model_inputs model_inputs_media_id_media_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_inputs
    ADD CONSTRAINT model_inputs_media_id_media_id_fk FOREIGN KEY (media_id) REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: model_inputs model_inputs_model_id_models_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_inputs
    ADD CONSTRAINT model_inputs_model_id_models_id_fk FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE CASCADE;


--
-- Name: models models_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.models
    ADD CONSTRAINT models_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: node_media node_media_media_id_media_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_media
    ADD CONSTRAINT node_media_media_id_media_id_fk FOREIGN KEY (media_id) REFERENCES public.media(id) ON DELETE CASCADE;


--
-- Name: password_reset_tokens password_reset_tokens_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: pricing_audit_log pricing_audit_log_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_audit_log
    ADD CONSTRAINT pricing_audit_log_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id);


--
-- Name: quota_reservations quota_reservations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quota_reservations
    ADD CONSTRAINT quota_reservations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: review_queue review_queue_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_queue
    ADD CONSTRAINT review_queue_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: review_queue review_queue_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.review_queue
    ADD CONSTRAINT review_queue_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.users(id);


--
-- Name: sentence_embeddings sentence_embeddings_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sentence_embeddings
    ADD CONSTRAINT sentence_embeddings_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: tags tags_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_style_prompts user_style_prompts_user_id_users_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_style_prompts
    ADD CONSTRAINT user_style_prompts_user_id_users_id_fk FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_subscriptions user_subscriptions_trial_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_subscriptions
    ADD CONSTRAINT user_subscriptions_trial_approved_by_fkey FOREIGN KEY (trial_approved_by) REFERENCES public.users(id);


--
-- Name: user_subscriptions user_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_subscriptions
    ADD CONSTRAINT user_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

