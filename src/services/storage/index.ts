import { StorageProvider } from './interface';
import { S3StorageProvider } from './s3Provider';

export function createStorageProvider(): StorageProvider {
  return new S3StorageProvider();
}

export const storageProvider = createStorageProvider();

export { StorageProvider } from './interface';
