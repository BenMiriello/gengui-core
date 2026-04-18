export interface StorageProvider {
  upload(
    userId: string,
    mediaId: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<string>;
  /** Upload a file at an explicit key (no path derivation). */
  uploadFile(key: string, buffer: Buffer, mimeType: string): Promise<void>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, expiresIn?: number): Promise<string>;
  downloadToBuffer(key: string): Promise<Buffer>;
  healthCheck(): Promise<boolean>;
}

export interface UploadResult {
  key: string;
  size: number;
}
