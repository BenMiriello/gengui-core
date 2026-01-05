import sharp from 'sharp';
import { logger } from '../utils/logger';

export interface ImageDimensions {
  width: number;
  height: number;
}

class ImageProcessor {
  async extractDimensions(buffer: Buffer): Promise<ImageDimensions> {
    try {
      const metadata = await sharp(buffer).metadata();

      if (!metadata.width || !metadata.height) {
        throw new Error('Unable to extract image dimensions');
      }

      return {
        width: metadata.width,
        height: metadata.height
      };
    } catch (error) {
      logger.error({ error }, 'Failed to extract image dimensions');
      throw error;
    }
  }

  async createThumbnail(buffer: Buffer, size: number): Promise<Buffer> {
    try {
      const thumbnail = await sharp(buffer)
        .resize(size, size, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({ quality: 85 })
        .toBuffer();

      logger.info({ size, originalSize: buffer.length, thumbnailSize: thumbnail.length }, 'Thumbnail created');

      return thumbnail;
    } catch (error) {
      logger.error({ error, size }, 'Failed to create thumbnail');
      throw error;
    }
  }
}

export const imageProcessor = new ImageProcessor();
