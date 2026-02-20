export interface StorageProvider {
  upload(
    userId: string,
    mediaId: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<string>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, expiresIn?: number): Promise<string>;
  downloadToBuffer(key: string): Promise<Buffer>;
  healthCheck(): Promise<boolean>;
}

export interface UploadResult {
  key: string;
  size: number;
}
