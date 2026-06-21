// ============================================================================
// S3 Storage Service - Upload, retrieve, and manage generated images via MinIO
// Auto-delete after configured expiry period using offline date calculations
// ============================================================================

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { Env, ImageMetadata } from '../types.js';

export class S3StorageService {
  private s3: S3Client;
  private bucketName: string;
  private expiryHours: number;
  private timezone: string;

  constructor(env: Env) {
    this.bucketName = env.MINIO_BUCKET_NAME || 'image-generation';
    this.expiryHours = parseInt(env.IMAGE_EXPIRY_HOURS || '24', 10);
    this.timezone = env.TZ || 'UTC';

    this.s3 = new S3Client({
      endpoint: env.MINIO_ENDPOINT,
      region: env.MINIO_REGION || 'us-east-1',
      credentials: {
        accessKeyId: env.MINIO_ACCESS_KEY_ID,
        secretAccessKey: env.MINIO_SECRET_ACCESS_KEY,
      },
      forcePathStyle: env.MINIO_FORCE_PATH_STYLE === 'true' || true,
    });
  }

  /**
   * Upload generated image to S3/MinIO
   */
  async uploadImage(
    imageData: string | ArrayBuffer,
    metadata: Omit<ImageMetadata, 'id' | 'expiresAt' | 'createdAt'>
  ): Promise<{ id: string; url: string; expiresAt: number }> {
    const id = this.generateId();
    const timestamp = Date.now();
    const expiresAt = timestamp + this.expiryHours * 60 * 60 * 1000;

    const fullMetadata: ImageMetadata = {
      ...metadata,
      id,
      createdAt: timestamp,
      expiresAt,
    };

    // Convert base64 to Uint8Array if needed
    let body: Uint8Array;
    if (typeof imageData === 'string') {
      if (imageData.startsWith('data:')) {
        const base64 = imageData.split(',')[1];
        body = this.base64ToUint8Array(base64);
      } else {
        body = this.base64ToUint8Array(imageData);
      }
    } else {
      body = new Uint8Array(imageData);
    }

    // Generate key with date-based prefix for organization (timezone-aware)
    const datePrefix = this.getDatePrefix(timestamp);
    const key = `images/${datePrefix}/${id}.png`;

    // Upload to S3/MinIO
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: body,
        ContentType: 'image/png',
        CacheControl: `public, max-age=${this.expiryHours * 3600}`,
        Metadata: {
          model: fullMetadata.model,
          prompt: fullMetadata.prompt.substring(0, 500), // Truncate for metadata
          createdat: String(fullMetadata.createdAt),
          expiresat: String(fullMetadata.expiresAt),
        },
      })
    );

    // Generate URL - use worker proxy URL
    const url = `/${key}`;

    return { id, url, expiresAt };
  }

  /**
   * Retrieve image metadata and data by ID
   */
  async getImage(id: string): Promise<{ metadata: ImageMetadata; data: ArrayBuffer } | null> {
    const listed = await this.s3.send(
      new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: 'images/',
        MaxKeys: 100,
      })
    );

    const matchingObject = listed.Contents?.find((obj) => obj.Key?.includes(id));
    if (!matchingObject || !matchingObject.Key) {
      return null;
    }

    const res = await this.getImageByKey(matchingObject.Key);
    if (!res) return null;

    return {
      metadata: res.metadata,
      data: res.data,
    };
  }

  /**
   * Retrieve image metadata and data directly by S3 Object key
   */
  async getImageByKey(key: string): Promise<{ metadata: ImageMetadata; data: ArrayBuffer; contentType: string } | null> {
    try {
      const response = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        })
      );

      if (!response.Body) {
        return null;
      }

      // Convert body stream to ArrayBuffer using standard Response streams
      const bytes = await new Response(response.Body as BodyInit).arrayBuffer();

      const custom = response.Metadata || {};
      const id = this.extractIdFromKey(key);

      const model = custom.model || '';
      const prompt = custom.prompt || '';
      const createdAt = parseInt(custom.createdat || custom.createdAt || String(Date.now()), 10);
      const expiresAt = parseInt(custom.expiresat || custom.expiresAt || String(Date.now() + this.expiryHours * 3600 * 1000), 10);

      const metadata: ImageMetadata = {
        id,
        model,
        prompt,
        createdAt,
        expiresAt,
        parameters: {},
      };

      return {
        metadata,
        data: bytes,
        contentType: response.ContentType || 'image/png',
      };
    } catch (err) {
      console.error(`Error reading key ${key} from S3:`, err);
      return null;
    }
  }

  /**
   * Delete expired images
   */
  async cleanupExpired(): Promise<number> {
    const now = Date.now();
    let deleted = 0;
    let continuationToken: string | undefined = undefined;

    do {
      const commandInput: any = {
        Bucket: this.bucketName,
        Prefix: 'images/',
        MaxKeys: 1000,
      };
      if (continuationToken) {
        commandInput.ContinuationToken = continuationToken;
      }

      const listed = await this.s3.send(new ListObjectsV2Command(commandInput));
      if (!listed.Contents || listed.Contents.length === 0) {
        break;
      }

      const expiredKeys: { Key: string }[] = [];

      for (const obj of listed.Contents) {
        if (!obj.Key) continue;

        const id = this.extractIdFromKey(obj.Key);
        const parts = id.split('-');
        let createdAt = 0;

        if (parts.length > 0) {
          const parsed = parseInt(parts[0], 36);
          if (!isNaN(parsed)) {
            createdAt = parsed;
          }
        }

        if (createdAt === 0 && obj.LastModified) {
          createdAt = obj.LastModified.getTime();
        }

        const expiresAt = createdAt + this.expiryHours * 60 * 60 * 1000;

        if (expiresAt < now) {
          expiredKeys.push({ Key: obj.Key });
        }
      }

      if (expiredKeys.length > 0) {
        await this.s3.send(
          new DeleteObjectsCommand({
            Bucket: this.bucketName,
            Delete: {
              Objects: expiredKeys,
              Quiet: true,
            },
          })
        );
        deleted += expiredKeys.length;
      }

      continuationToken = listed.NextContinuationToken;
    } while (continuationToken !== undefined);

    return deleted;
  }

  /**
   * List all images (with pagination)
   */
  async listImages(options: { limit?: number; prefix?: string; cursor?: string } = {}): Promise<{
    images: Array<{ id: string; url: string; createdAt: number; expiresAt: number }>;
    truncated: boolean;
    cursor?: string;
  }> {
    const commandInput: any = {
      Bucket: this.bucketName,
      Prefix: options.prefix || 'images/',
      MaxKeys: options.limit || 100,
    };
    if (options.cursor) {
      commandInput.ContinuationToken = options.cursor;
    }

    const listed = await this.s3.send(new ListObjectsV2Command(commandInput));

    const images = (listed.Contents || []).map((obj) => {
      const key = obj.Key || '';
      const id = this.extractIdFromKey(key);
      const url = `/${key}`;

      const parts = id.split('-');
      let createdAt = 0;

      if (parts.length > 0) {
        const parsed = parseInt(parts[0], 36);
        if (!isNaN(parsed)) {
          createdAt = parsed;
        }
      }

      if (createdAt === 0 && obj.LastModified) {
        createdAt = obj.LastModified.getTime();
      }

      const expiresAt = createdAt + this.expiryHours * 60 * 60 * 1000;

      return {
        id,
        url,
        createdAt,
        expiresAt,
      };
    });

    return {
      images,
      truncated: listed.IsTruncated || false,
      cursor: listed.NextContinuationToken,
    };
  }

  /**
   * Delete a specific image by ID
   */
  async deleteImage(id: string): Promise<boolean> {
    const listed = await this.s3.send(
      new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: 'images/',
        MaxKeys: 100,
      })
    );

    const matchingObject = listed.Contents?.find((obj) => obj.Key?.includes(id));
    if (!matchingObject || !matchingObject.Key) {
      return false;
    }

    await this.s3.send(
      new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: matchingObject.Key,
      })
    );
    return true;
  }

  /**
   * Get storage statistics
   */
  async getStats(): Promise<{
    totalImages: number;
    totalSize: number;
    oldestImage?: number;
    newestImage?: number;
  }> {
    let total = 0;
    let size = 0;
    let oldest: number | undefined;
    let newest: number | undefined;
    let continuationToken: string | undefined = undefined;

    do {
      const commandInput: any = {
        Bucket: this.bucketName,
        Prefix: 'images/',
        MaxKeys: 1000,
      };
      if (continuationToken) {
        commandInput.ContinuationToken = continuationToken;
      }

      const listed = await this.s3.send(new ListObjectsV2Command(commandInput));
      if (!listed.Contents || listed.Contents.length === 0) {
        break;
      }

      for (const obj of listed.Contents) {
        if (!obj.Key) continue;
        total++;
        size += obj.Size || 0;

        const id = this.extractIdFromKey(obj.Key);
        const parts = id.split('-');
        let createdAt = 0;

        if (parts.length > 0) {
          const parsed = parseInt(parts[0], 36);
          if (!isNaN(parsed)) {
            createdAt = parsed;
          }
        }

        if (createdAt === 0 && obj.LastModified) {
          createdAt = obj.LastModified.getTime();
        }

        if (createdAt > 0) {
          if (!oldest || createdAt < oldest) oldest = createdAt;
          if (!newest || createdAt > newest) newest = createdAt;
        }
      }

      continuationToken = listed.NextContinuationToken;
    } while (continuationToken !== undefined);

    return { totalImages: total, totalSize: size, oldestImage: oldest, newestImage: newest };
  }

  // ===== Helper Methods =====

  private getDatePrefix(timestamp: number): string {
    try {
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: this.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });

      const parts = formatter.formatToParts(new Date(timestamp));
      const year = parts.find((p) => p.type === 'year')?.value;
      const month = parts.find((p) => p.type === 'month')?.value;
      const day = parts.find((p) => p.type === 'day')?.value;

      return `${year}-${month}-${day}`;
    } catch (err) {
      console.error(`Invalid timezone "${this.timezone}", falling back to UTC:`, err);
      return new Date(timestamp).toISOString().split('T')[0];
    }
  }

  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    return `${timestamp}-${random}`;
  }

  private extractIdFromKey(key: string): string {
    const match = key.match(/images\/[\d-]+\/([^.]+)\.png/);
    return match ? match[1] : key;
  }

  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
}
