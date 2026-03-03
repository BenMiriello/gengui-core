declare global {
  namespace Express {
    interface User {
      id: string;
      email: string;
      username: string;
      role: string;
      emailVerified: boolean;
      createdAt: string;
      pendingEmail: string | null;
      defaultImageWidth: number;
      defaultImageHeight: number;
      defaultStylePreset: string | null;
      hiddenPresetIds: string[];
      oauthProvider: string | null;
      hasPassword: boolean;
    }

    interface Request {
      user?: User;
      sessionId?: string;
      id?: string;
      log?: {
        info: (obj: object | string, msg?: string, ...args: unknown[]) => void;
        error: (obj: object | string, msg?: string, ...args: unknown[]) => void;
        warn: (obj: object | string, msg?: string, ...args: unknown[]) => void;
        debug: (obj: object | string, msg?: string, ...args: unknown[]) => void;
      };
    }
  }
}

export {};
