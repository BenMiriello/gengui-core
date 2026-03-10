import type { activities } from '../models/schema';

export type Activity = typeof activities.$inferSelect;
export type NewActivity = typeof activities.$inferInsert;

export type ActivityType =
  | 'image_generation'
  | 'document_analysis'
  | 'pdf_export'
  | 'docx_export'
  | 'txt_export'
  | 'md_export'
  | 'drive_import'
  | 'drive_export';

export type ActivityStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ActivityProgress {
  stage?: number;
  totalStages?: number;
  stageName?: string;
  percent?: number;
}

export interface CreateActivityFromJobParams {
  jobId: string;
  userId: string;
  activityType: ActivityType;
  targetType: string;
  targetId: string;
  title: string;
  viewedAt?: Date;
}

export interface CreateActivityFromMediaParams {
  mediaId: string;
  userId: string;
  title: string;
}

export interface UpdateActivityStatusParams {
  resultUrl?: string;
  errorMessage?: string;
}

export interface ActivitySSEEvent {
  eventType: 'activity-created' | 'activity-updated';
  activity: Activity;
}

export interface ListActivitiesOptions {
  status?: ActivityStatus;
  limit?: number;
  offset?: number;
}
