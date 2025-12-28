import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { StorageProvider } from './interface';
import { s3 } from '../s3';
import { logger } from '../../utils/logger';
import { PRESIGNED_S3_URL_EXPIRATION } from '../cache';

export class S3StorageProvider implements StorageProvider {
  private client: S3Client;
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

    this.client = new S3Client(config);
    this.bucket = process.env.S3_BUCKET || process.env.MINIO_BUCKET || 'media';
  }

  async upload(
    userId: string,
    mediaId: string,
    buffer: Buffer,
    mimeType: string
  ): Promise<string> {
    const ext = this.getExtensionFromMimeType(mimeType);
    const key = `users/${userId}/media/${mediaId}${ext}`;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    });

    await this.client.send(command);
    logger.info({ key, size: buffer.length }, 'Uploaded to S3');

    return key;
  }

  async delete(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    await this.client.send(command);
    logger.info({ key }, 'Deleted from S3');
  }

  async getSignedUrl(key: string, expiresIn: number = PRESIGNED_S3_URL_EXPIRATION): Promise<string> {
    return await s3.generateDownloadUrl(key, expiresIn);
  }

  async downloadToBuffer(key: string): Promise<Buffer> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    const response = await this.client.send(command);

    if (!response.Body) {
      throw new Error('No body in S3 response');
    }

    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as any) {
      chunks.push(chunk);
    }

    const buffer = Buffer.concat(chunks);
    logger.info({ key, size: buffer.length }, 'Downloaded from S3');

    return buffer;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await s3.generateDownloadUrl('health-check', 60);
      return true;
    } catch {
      return false;
    }
  }

  private getExtensionFromMimeType(mimeType: string): string {
    const mimeToExt: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/svg+xml': '.svg',
      'video/mp4': '.mp4',
      'video/mpeg': '.mpeg',
      'video/webm': '.webm',
      'application/pdf': '.pdf',
    };

    return mimeToExt[mimeType] || '';
  }
}
