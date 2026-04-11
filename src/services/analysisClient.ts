interface AnalyzeRequest {
  document_id: string;
  user_id: string;
  document_content: string;
  segments: Array<{ id: string; text: string; order: number }>;
  domain: string | null;
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

async function startAnalysis(params: AnalyzeRequest): Promise<AnalyzeResponse> {
  const res = await fetch(`${ANALYSIS_SERVICE_URL}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`Analysis service error: ${res.status}`);
  return (await res.json()) as AnalyzeResponse;
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

async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${ANALYSIS_SERVICE_URL}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export const analysisClient = {
  startAnalysis,
  getEntities,
  getConnections,
  getEntity,
  healthCheck,
};

export type {
  AnalyzeRequest,
  AnalyzeResponse,
  EntityResponse,
  MentionResponse,
};
