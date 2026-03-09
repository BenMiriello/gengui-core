export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  createdTime?: string;
  size?: string;
  parents?: string[];
  webViewLink?: string;
  iconLink?: string;
}

export interface DriveConnectionStatus {
  connected: boolean;
  email?: string;
  expiresAt?: string;
}

export interface DriveListResponse {
  files: DriveFile[];
  nextPageToken?: string;
}

export interface DriveTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}
