interface AnalyzeRequest {
  document_id: string;
  user_id: string;
  document_content: string;
  segments: Array<{ id: string; text: string; order: number }>;
  domain: string | null;
  enabled_layers?: string[];
  chat_message?: string;
  chat_history?: Array<{
    role: string;
    content: string;
    metadata?: Record<string, unknown>;
  }>;
  requested_stages?: string[];
  segment_ids?: string[];
  automation_level?: string;
  confidence_threshold?: number;
}

interface AnalyzeResponse {
  run_id: string;
}

interface MentionResponse {
  text: string;
  segment_id?: string | null;
  start?: number | null;
  end?: number | null;
}

interface EntityResponse {
  id: string;
  type: string;
  name: string;
  description: string;
  aliases: string[];
  documentId: string;
  userId: string;
  mentions?: MentionResponse[];
}

const ANALYSIS_SERVICE_URL =
  process.env.ANALYSIS_SERVICE_URL || 'http://localhost:8001';

interface ClassifyResult {
  domain: string;
  confidence: number;
}

async function classify(params: { document_id: string; sample_text: string }): Promise<ClassifyResult> {
  const res = await fetch(`${ANALYSIS_SERVICE_URL}/api/classify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`Analysis service error: ${res.status}`);
  return (await res.json()) as ClassifyResult;
}

async function startAnalysis(params: AnalyzeRequest): Promise<AnalyzeResponse> {
  const res = await fetch(`${ANALYSIS_SERVICE_URL}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`Analysis service error: ${res.status}`);
  return (await res.json()) as AnalyzeResponse;
}

interface ChatActionResponse {
  type: string;
  stages?: string[] | null;
  segment_ids?: string[] | null;
  reason: string;
}

interface ChatResult {
  response: string;
  proposed_action?: ChatActionResponse | null;
}

async function chat(params: {
  document_id: string;
  user_id: string;
  message: string;
  chat_history?: Array<{ role: string; content: string }>;
}): Promise<ChatResult> {
  const res = await fetch(`${ANALYSIS_SERVICE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`Analysis service error: ${res.status}`);
  return (await res.json()) as ChatResult;
}

async function getEntities(
  documentId: string,
): Promise<{ entities: EntityResponse[] }> {
  const res = await fetch(
    `${ANALYSIS_SERVICE_URL}/api/graph/${documentId}/entities`,
  );
  if (!res.ok) throw new Error(`Analysis service error: ${res.status}`);
  return (await res.json()) as { entities: EntityResponse[] };
}

async function getConnections(
  documentId: string,
): Promise<{ connections: unknown[] }> {
  const res = await fetch(
    `${ANALYSIS_SERVICE_URL}/api/graph/${documentId}/connections`,
  );
  if (!res.ok) throw new Error(`Analysis service error: ${res.status}`);
  return (await res.json()) as { connections: unknown[] };
}

async function getEntity(entityId: string): Promise<EntityResponse | null> {
  const res = await fetch(
    `${ANALYSIS_SERVICE_URL}/api/graph/entities/${entityId}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Analysis service error: ${res.status}`);
  return (await res.json()) as EntityResponse;
}

async function getCoverage(
  documentId: string,
  totalSegments?: number,
): Promise<{
  coverage: Record<string, { total: number }>;
  percentage?: { percent: number; analyzed: number; total: number };
}> {
  const params = totalSegments ? `?total_segments=${totalSegments}` : '';
  const res = await fetch(
    `${ANALYSIS_SERVICE_URL}/api/coverage/${documentId}${params}`,
  );
  if (!res.ok) throw new Error(`Analysis service error: ${res.status}`);
  return (await res.json()) as {
    coverage: Record<string, { total: number }>;
    percentage?: { percent: number; analyzed: number; total: number };
  };
}

async function deleteEntities(
  documentId: string,
): Promise<{ deleted: number }> {
  const res = await fetch(
    `${ANALYSIS_SERVICE_URL}/api/graph/${documentId}/entities`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`Analysis service error: ${res.status}`);
  return (await res.json()) as { deleted: number };
}

async function compactMessages(
  messages: Array<{ role: string; content: string }>,
): Promise<{ summary: string }> {
  const res = await fetch(`${ANALYSIS_SERVICE_URL}/api/compact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) throw new Error(`Analysis service error: ${res.status}`);
  return (await res.json()) as { summary: string };
}

async function cancelRun(runId: string): Promise<{ cancelled: boolean }> {
  const res = await fetch(
    `${ANALYSIS_SERVICE_URL}/api/analyze/${runId}/cancel`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
  );
  if (!res.ok) throw new Error(`Analysis service error: ${res.status}`);
  return (await res.json()) as { cancelled: boolean };
}

async function getEvents(
  documentId: string,
  limit = 100,
  offset = 0,
): Promise<{ events: Record<string, unknown>[] }> {
  const res = await fetch(
    `${ANALYSIS_SERVICE_URL}/api/events/${documentId}?limit=${limit}&offset=${offset}`,
  );
  if (!res.ok) throw new Error(`Analysis service error: ${res.status}`);
  return (await res.json()) as { events: Record<string, unknown>[] };
}

async function getProposals(
  documentId: string,
): Promise<{ proposals: Record<string, unknown[]>; total: number }> {
  const res = await fetch(
    `${ANALYSIS_SERVICE_URL}/api/proposals/${documentId}`,
  );
  if (!res.ok) throw new Error(`Analysis service error: ${res.status}`);
  return (await res.json()) as {
    proposals: Record<string, unknown[]>;
    total: number;
  };
}

async function approveProposal(
  proposalId: string,
): Promise<{ approved: boolean; proposal_id: string }> {
  const res = await fetch(
    `${ANALYSIS_SERVICE_URL}/api/proposals/${proposalId}/approve`,
    { method: 'POST' },
  );
  if (!res.ok) throw new Error(`Analysis service error: ${res.status}`);
  return (await res.json()) as { approved: boolean; proposal_id: string };
}

async function dismissProposal(
  proposalId: string,
): Promise<{ dismissed: boolean; proposal_id: string }> {
  const res = await fetch(
    `${ANALYSIS_SERVICE_URL}/api/proposals/${proposalId}/dismiss`,
    { method: 'POST' },
  );
  if (!res.ok) throw new Error(`Analysis service error: ${res.status}`);
  return (await res.json()) as { dismissed: boolean; proposal_id: string };
}

async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${ANALYSIS_SERVICE_URL}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export const analysisClient = {
  chat,
  classify,
  compactMessages,
  startAnalysis,
  cancelRun,
  getEntities,
  getConnections,
  getEntity,
  getCoverage,
  getEvents,
  deleteEntities,
  getProposals,
  approveProposal,
  dismissProposal,
  healthCheck,
};

export type {
  AnalyzeRequest,
  AnalyzeResponse,
  EntityResponse,
  MentionResponse,
};
