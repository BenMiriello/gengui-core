declare module 'html-docx-js' {
  interface DocxOptions {
    orientation?: 'portrait' | 'landscape';
    margins?: {
      top?: number;
      right?: number;
      bottom?: number;
      left?: number;
      header?: number;
      footer?: number;
    };
    width?: number;
    height?: number;
    title?: string;
    subject?: string;
    creator?: string;
    keywords?: string[];
    description?: string;
    lastModifiedBy?: string;
    revision?: number;
    createdAt?: Date;
    modifiedAt?: Date;
    font?: {
      name?: string;
      size?: number;
    };
    table?: {
      row?: {
        cantSplit?: boolean;
      };
    };
  }

  export function asBlob(html: string, options?: DocxOptions): Promise<Blob>;
}
