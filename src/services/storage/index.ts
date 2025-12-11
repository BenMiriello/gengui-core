import { StorageProvider } from './interface';
import { MinIOStorageProvider } from './minio';

export function createStorageProvider(): StorageProvider {
  return new MinIOStorageProvider();
}

export const storageProvider = createStorageProvider();

export { StorageProvider } from './interface';
