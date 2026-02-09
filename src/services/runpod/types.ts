/**
 * RunPod service types and constants
 */

// Job input structure for our generation endpoint
export interface RunPodJobInput {
  mediaId: string;
  userId: string;
  prompt: string;
  seed: string;
  width: string;
  height: string;
}

// Job policy for per-job configuration
export interface RunPodJobPolicy {
  executionTimeout?: number; // milliseconds (e.g., 20000 for 20s)
  lowPriority?: boolean;
  ttl?: number;
}

// RunPod job status response (matches SDK types)
// See: https://docs.runpod.io/serverless/references/job-states
export interface RunPodJobStatusResponse {
  id: string;
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
  delayTime?: number;
  executionTime?: number;
  output?: any;
  error?: string;
}
