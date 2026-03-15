/**
 * Analysis version configuration.
 * Tracks embedding model versions and provides version comparison utilities.
 */

export type AnalysisVersionStatus =
  | 'current'
  | 'supported'
  | 'deprecated'
  | 'discontinued';

export type EmbeddingColumn = 'embedding_1536' | 'embedding_1024';

export interface AnalysisVersion {
  version: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingColumn: EmbeddingColumn;
  status: AnalysisVersionStatus;
  deprecatedAt?: string;
  discontinuedAt?: string;
  changelog?: string;
}

export const ANALYSIS_VERSIONS: Record<string, AnalysisVersion> = {
  '0.0.1': {
    version: '0.0.1',
    embeddingModel: 'openai-3-small',
    embeddingDimensions: 1536,
    embeddingColumn: 'embedding_1536',
    status: 'supported',
    changelog: 'Initial release with OpenAI text-embedding-3-small',
  },
  '0.0.2': {
    version: '0.0.2',
    embeddingModel: 'voyage-4-lite',
    embeddingDimensions: 1024,
    embeddingColumn: 'embedding_1024',
    status: 'current',
    changelog: 'Voyage 4 Lite embeddings',
  },
};

export function getCurrentAnalysisVersion(): string {
  return '0.0.2';
}

export function getVersionConfig(version: string): AnalysisVersion {
  return ANALYSIS_VERSIONS[version] ?? ANALYSIS_VERSIONS['0.0.2'];
}

export function isVersionDeprecated(version: string): boolean {
  const config = ANALYSIS_VERSIONS[version];
  return config?.status === 'deprecated' || config?.status === 'discontinued';
}

export function isVersionDiscontinued(version: string): boolean {
  const config = ANALYSIS_VERSIONS[version];
  return config?.status === 'discontinued';
}

export interface VersionDiff {
  embeddingModelChanged: boolean;
  dimensionsChanged: boolean;
  requiresReanalysis: boolean;
}

export function getVersionDiff(from: string, to: string): VersionDiff {
  const fromV = ANALYSIS_VERSIONS[from];
  const toV = ANALYSIS_VERSIONS[to];

  if (!fromV || !toV) {
    return {
      embeddingModelChanged: true,
      dimensionsChanged: true,
      requiresReanalysis: true,
    };
  }

  const modelChanged = fromV.embeddingModel !== toV.embeddingModel;
  const dimsChanged = fromV.embeddingDimensions !== toV.embeddingDimensions;

  return {
    embeddingModelChanged: modelChanged,
    dimensionsChanged: dimsChanged,
    requiresReanalysis: modelChanged || dimsChanged,
  };
}

export function getEmbeddingColumnForVersion(version: string): EmbeddingColumn {
  return getVersionConfig(version).embeddingColumn;
}

export function getEmbeddingDimensionsForVersion(version: string): number {
  return getVersionConfig(version).embeddingDimensions;
}

export function getEmbeddingModelForVersion(version: string): string {
  return getVersionConfig(version).embeddingModel;
}
