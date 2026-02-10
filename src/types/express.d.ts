declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email?: string;
        username?: string;
        role: 'user' | 'admin';
        emailVerified?: boolean;
        createdAt?: string;
      };
      sessionId?: string;
    }
  }
}

export {};
