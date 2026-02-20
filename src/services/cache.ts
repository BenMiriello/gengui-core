import { METADATA_CACHE_TTL, URL_CACHE_TTL } from '../config/constants';
import { logger } from '../utils/logger';
import { redis } from './redis';

export interface MediaMetadata {
  width: number | null;
  height: number | null;
  mimeType: string | null;
}

export type MediaUrlType = 'full' | 'thumb';

class CacheService {
  private urlKey(mediaId: string, type: MediaUrlType): string {
    return `media:url:${mediaId}:${type}`;
  }

  private metadataKey(mediaId: string): string {
    return `media:metadata:${mediaId}`;
  }

  async getMediaUrl(
    mediaId: string,
    type: MediaUrlType,
  ): Promise<string | null> {
    try {
      const cached = await redis.get(this.urlKey(mediaId, type));
      if (cached) {
        logger.debug({ mediaId, type }, 'Cache hit for media URL');
      }
      return cached;
    } catch (error) {
      logger.error({ error, mediaId, type }, 'Failed to get cached URL');
      return null;
    }
  }

  async setMediaUrl(
    mediaId: string,
    type: MediaUrlType,
    url: string,
    ttl: number = URL_CACHE_TTL,
  ): Promise<void> {
    try {
      await redis.set(this.urlKey(mediaId, type), url, ttl);
      logger.debug({ mediaId, type, ttl }, 'Cached media URL');
    } catch (error) {
      logger.error({ error, mediaId, type }, 'Failed to cache URL');
    }
  }

  async getMetadata(mediaId: string): Promise<MediaMetadata | null> {
    try {
      const cached = await redis.get(this.metadataKey(mediaId));
      if (cached) {
        logger.debug({ mediaId }, 'Cache hit for metadata');
        return JSON.parse(cached);
      }
      return null;
    } catch (error) {
      logger.error({ error, mediaId }, 'Failed to get cached metadata');
      return null;
    }
  }

  async setMetadata(
    mediaId: string,
    metadata: MediaMetadata,
    ttl: number = METADATA_CACHE_TTL,
  ): Promise<void> {
    try {
      await redis.set(this.metadataKey(mediaId), JSON.stringify(metadata), ttl);
      logger.debug({ mediaId, ttl }, 'Cached metadata');
    } catch (error) {
      logger.error({ error, mediaId }, 'Failed to cache metadata');
    }
  }

  async delMediaUrl(mediaId: string): Promise<void> {
    try {
      await redis.del(this.urlKey(mediaId, 'full'));
      await redis.del(this.urlKey(mediaId, 'thumb'));
      logger.debug({ mediaId }, 'Deleted cached URLs');
    } catch (error) {
      logger.error({ error, mediaId }, 'Failed to delete cached URLs');
    }
  }

  async delMetadata(mediaId: string): Promise<void> {
    try {
      await redis.del(this.metadataKey(mediaId));
      logger.debug({ mediaId }, 'Deleted cached metadata');
    } catch (error) {
      logger.error({ error, mediaId }, 'Failed to delete cached metadata');
    }
  }
}

export const cache = new CacheService();
