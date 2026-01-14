import { db } from '../config/database';
import { media } from '../models/schema';
import { eq } from 'drizzle-orm';
import { storageProvider } from './storage';
import { imageProcessor } from './imageProcessor';
import { logger } from '../utils/logger';
import path from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export class ThumbnailProcessor {
  private s3Client: S3Client;
  private bucket: string;

  constructor() {
    const config: any = {
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || process.env.MINIO_ACCESS_KEY || 'minioadmin',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || process.env.MINIO_SECRET_KEY || 'minioadmin',
      },
    };

    const endpoint = process.env.S3_ENDPOINT;
    if (endpoint) {
      config.endpoint = endpoint;
      config.forcePathStyle = true;
    }

    this.s3Client = new S3Client(config);
    this.bucket = process.env.S3_BUCKET || process.env.MINIO_BUCKET || 'media';
  }

  async processThumbnail(mediaId: string): Promise<void> {
    try {
      const [mediaItem] = await db
        .select()
        .from(media)
        .where(eq(media.id, mediaId))
        .limit(1);

      if (!mediaItem) {
        logger.error({ mediaId }, 'Media not found for thumbnail generation');
        return;
      }

      if (mediaItem.s3KeyThumb) {
        logger.info({ mediaId }, 'Thumbnail already exists');
        return;
      }

      const storageKey = mediaItem.s3Key || mediaItem.storageKey;
      if (!storageKey) {
        logger.error({ mediaId }, 'No storage key for thumbnail generation');
        return;
      }

      const startTime = Date.now();

      const originalBuffer = await storageProvider.downloadToBuffer(storageKey);

      const thumbnailBuffer = await imageProcessor.createThumbnail(originalBuffer, 256);

      const ext = path.extname(storageKey);
      const thumbKey = `users/${mediaItem.userId}/media/thumbs/${mediaItem.id}${ext}`;

      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: thumbKey,
        Body: thumbnailBuffer,
        ContentType: 'image/jpeg',
      });

      await this.s3Client.send(command);

      await db
        .update(media)
        .set({ s3KeyThumb: thumbKey })
        .where(eq(media.id, mediaId));

      const duration = Date.now() - startTime;
      logger.info({ mediaId, duration, thumbKey, size: thumbnailBuffer.length }, 'Thumbnail generated successfully');

    } catch (error) {
      logger.error({ error, mediaId }, 'Failed to process thumbnail');
      throw error;
    }
  }
}

export const thumbnailProcessor = new ThumbnailProcessor();
