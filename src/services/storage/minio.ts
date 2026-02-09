import { Client } from 'minio';
import { PRESIGNED_S3_URL_EXPIRATION } from '../../config/constants';
import { env } from '../../config/env';
import type { StorageProvider } from './interface';

export class MinIOStorageProvider implements StorageProvider {
  private client: Client;
  private bucket: string;

  constructor() {
    this.client = new Client({
      endPoint: env.MINIO_ENDPOINT,
      port: env.MINIO_PORT,
      useSSL: false,
      accessKey: env.MINIO_ACCESS_KEY,
      secretKey: env.MINIO_SECRET_KEY,
    });
    this.bucket = env.MINIO_BUCKET;
  }

  async upload(userId: string, mediaId: string, buffer: Buffer, mimeType: string): Promise<string> {
    const ext = this.getExtensionFromMimeType(mimeType);
    const key = `users/${userId}/media/${mediaId}${ext}`;

    await this.client.putObject(this.bucket, key, buffer, buffer.length, {
      'Content-Type': mimeType,
    });

    return key;
  }

  async delete(key: string): Promise<void> {
    await this.client.removeObject(this.bucket, key);
  }

  async getSignedUrl(
    key: string,
    expiresIn: number = PRESIGNED_S3_URL_EXPIRATION
  ): Promise<string> {
    return await this.client.presignedGetObject(this.bucket, key, expiresIn);
  }

  async downloadToBuffer(key: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const stream = await this.client.getObject(this.bucket, key);

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      const exists = await this.client.bucketExists(this.bucket);
      return exists;
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
