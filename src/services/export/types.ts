export type ExportFormat = 'pdf' | 'docx';

export interface ExportOptions {
  format: 'a4' | 'letter';
  orientation: 'portrait' | 'landscape';
  margins?: {
    top: string;
    right: string;
    bottom: string;
    left: string;
  };
}

export interface ExportResult {
  buffer: Buffer;
  mimeType: string;
  extension: string;
}

export type CancellationCallback = () => boolean;
