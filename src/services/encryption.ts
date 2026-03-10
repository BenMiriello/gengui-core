import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getEncryptionKey(): Buffer {
  const keyHex = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
  if (!keyHex) {
    throw new Error('GOOGLE_TOKEN_ENCRYPTION_KEY not configured');
  }
  if (keyHex.length !== 64) {
    throw new Error(
      'GOOGLE_TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes)',
    );
  }
  return Buffer.from(keyHex, 'hex');
}

export interface EncryptedData {
  ciphertext: string;
  iv: string;
  tag: string;
}

export function encrypt(plaintext: string): EncryptedData {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const tag = cipher.getAuthTag();

  return {
    ciphertext: encrypted,
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
  };
}

export function decrypt(ciphertext: string, iv: string, tag: string): string {
  const key = getEncryptionKey();
  const ivBuffer = Buffer.from(iv, 'hex');
  const tagBuffer = Buffer.from(tag, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, ivBuffer);
  decipher.setAuthTag(tagBuffer);

  let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
