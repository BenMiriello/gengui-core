CREATE TABLE analysis_chats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    title TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE analysis_chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id UUID NOT NULL REFERENCES analysis_chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_analysis_chats_document ON analysis_chats(document_id);
CREATE INDEX idx_analysis_chats_user ON analysis_chats(user_id);
CREATE INDEX idx_analysis_chat_messages_chat ON analysis_chat_messages(chat_id);
CREATE INDEX idx_analysis_chat_messages_created ON analysis_chat_messages(chat_id, created_at);
