import type 'express';

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
      oauthUserId: string | null;
    }

    interface Request {
      user?: User;
      sessionId?: string;
    }
  }
}
