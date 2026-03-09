import { logger } from '../../utils/logger';
import type { DriveFile, DriveListResponse } from './types';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';

export class GoogleDriveClient {
  constructor(private accessToken: string) {}

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = endpoint.startsWith('http')
      ? endpoint
      : `${DRIVE_API_BASE}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      logger.error(
        { status: response.status, error, endpoint },
        'Google Drive API error',
      );
      throw new Error(`Google Drive API error: ${response.status}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  async listFiles(
    folderId?: string,
    pageToken?: string,
  ): Promise<DriveListResponse> {
    const params = new URLSearchParams({
      fields:
        'nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,size,parents,webViewLink,iconLink)',
      pageSize: '100',
    });

    if (folderId) {
      params.append('q', `'${folderId}' in parents and trashed = false`);
    } else {
      params.append('q', 'trashed = false');
    }

    if (pageToken) {
      params.append('pageToken', pageToken);
    }

    return this.request<DriveListResponse>(`/files?${params.toString()}`);
  }

  async getFileMetadata(fileId: string): Promise<DriveFile> {
    const params = new URLSearchParams({
      fields:
        'id,name,mimeType,modifiedTime,createdTime,size,parents,webViewLink,iconLink',
    });

    return this.request<DriveFile>(`/files/${fileId}?${params.toString()}`);
  }

  async downloadFile(fileId: string): Promise<ArrayBuffer> {
    const url = `${DRIVE_API_BASE}/files/${fileId}?alt=media`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.status}`);
    }

    return response.arrayBuffer();
  }

  async exportGoogleDoc(
    fileId: string,
    mimeType: string,
  ): Promise<ArrayBuffer> {
    const params = new URLSearchParams({ mimeType });
    const url = `${DRIVE_API_BASE}/files/${fileId}/export?${params.toString()}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to export file: ${response.status}`);
    }

    return response.arrayBuffer();
  }

  async uploadFile(
    folderId: string | null,
    name: string,
    content: Buffer | string,
    mimeType: string,
  ): Promise<DriveFile> {
    const metadata: Record<string, unknown> = {
      name,
      mimeType,
    };

    if (folderId) {
      metadata.parents = [folderId];
    }

    const boundary = '-------314159265358979323846';
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const body =
      delimiter +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) +
      delimiter +
      `Content-Type: ${mimeType}\r\n` +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      (Buffer.isBuffer(content)
        ? content.toString('base64')
        : Buffer.from(content).toString('base64')) +
      closeDelimiter;

    const response = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to upload file: ${response.status} - ${error}`);
    }

    return response.json() as Promise<DriveFile>;
  }

  async getUserEmail(): Promise<string | null> {
    try {
      const response = await fetch(
        'https://www.googleapis.com/oauth2/v2/userinfo',
        {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
          },
        },
      );

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as { email?: string };
      return data.email || null;
    } catch {
      return null;
    }
  }
}
