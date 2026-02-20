import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PRESIGNED_S3_URL_EXPIRATION } from '../config/constants';
import { logger } from '../utils/logger';

class S3Service {
  private client: S3Client;
  private bucket: string;
  private endpoint?: string;

  constructor() {
    this.bucket = process.env.S3_BUCKET || process.env.MINIO_BUCKET || 'media';
    this.endpoint = process.env.S3_ENDPOINT;

    const config: any = {
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId:
          process.env.AWS_ACCESS_KEY_ID ||
          process.env.MINIO_ACCESS_KEY ||
          'minioadmin',
        secretAccessKey:
          process.env.AWS_SECRET_ACCESS_KEY ||
          process.env.MINIO_SECRET_KEY ||
          'minioadmin',
      },
    };

    if (this.endpoint) {
      config.endpoint = this.endpoint;
      config.forcePathStyle = true;
    }

    this.client = new S3Client(config);

    logger.info(
      {
        bucket: this.bucket,
        endpoint: this.endpoint || 'AWS S3',
      },
      'S3 service initialized',
    );
  }

  async generateUploadUrl(key: string, expiresIn = 3600): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: 'image/png',
    });

    const url = await getSignedUrl(this.client, command, { expiresIn });
    logger.info({ key, expiresIn }, 'Generated upload URL');
    return url;
  }

  async generateDownloadUrl(
    key: string,
    expiresIn = PRESIGNED_S3_URL_EXPIRATION,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    const url = await getSignedUrl(this.client, command, { expiresIn });
    logger.debug(
      {
        key,
        bucket: this.bucket,
        expiresIn,
        urlPrefix: url.substring(0, 50),
      },
      'Generated download URL',
    );
    return url;
  }

  async deleteObject(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    await this.client.send(command);
    logger.info({ key }, 'Deleted object from S3');
  }

  async uploadBuffer(
    buffer: Buffer,
    key: string,
    contentType: string = 'application/octet-stream',
  ): Promise<void> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    });

    await this.client.send(command);
    logger.info(
      { key, size: buffer.length, contentType },
      'Uploaded buffer to S3',
    );
  }

  async downloadBuffer(key: string): Promise<Buffer> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    const response = await this.client.send(command);

    if (!response.Body) {
      throw new Error(`No body in S3 response for key: ${key}`);
    }

    // Convert stream to buffer
    const chunks: Uint8Array[] = [];
    const stream = response.Body as NodeJS.ReadableStream;

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Uint8Array) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  getBucket(): string {
    return this.bucket;
  }
}

export const s3 = new S3Service();
