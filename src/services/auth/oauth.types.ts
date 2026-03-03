export type OAuthProvider = 'google';

export interface OAuthProfile {
  provider: OAuthProvider;
  providerId: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  avatarUrl?: string;
}

export interface OAuthUserLookupResult {
  action: 'create' | 'link' | 'login' | 'confirm_password';
  user?: {
    id: string;
    email: string;
    emailVerified: boolean;
    passwordHash: string | null;
    oauthProvider: string | null;
    oauthProviderId: string | null;
  };
  reason?: string;
}

export interface AccountLinkingValidation {
  eligible: boolean;
  requiresPasswordConfirmation: boolean;
  reason?: string;
}
