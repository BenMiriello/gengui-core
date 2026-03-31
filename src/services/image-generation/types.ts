export interface ReferenceImage {
  buffer: Buffer;
  mimeType: string;
  nodeId: string;
  nodeName: string;
}

export interface GenerationInput {
  mediaId: string;
  userId: string;
  prompt: string;
  seed: number;
  width: number;
  height: number;
  stylePrompt?: string;
  negativePrompt?: string;
  guidanceScale?: number;
  referenceImages?: ReferenceImage[];
}

export interface DimensionConstraint {
  width: number;
  height: number;
}

export type DimensionWhitelist =
  | DimensionConstraint[]
  | { min: number; max: number; step: number };
