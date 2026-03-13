import { type MockInstance, vi } from 'vitest';

interface EmailServiceMock {
  sendVerificationEmail: MockInstance<
    (email: string, token: string) => Promise<void>
  >;
  sendEmailChangeVerification: MockInstance<
    (newEmail: string, token: string) => Promise<void>
  >;
  sendPasswordResetEmail: MockInstance<
    (email: string, token: string) => Promise<void>
  >;
  sendPasswordChangedEmail: MockInstance<(email: string) => Promise<void>>;
  getLastVerificationToken: () => string | null;
  getLastPasswordResetToken: () => string | null;
  reset: () => void;
}

let lastVerificationToken: string | null = null;
let lastPasswordResetToken: string | null = null;

export function createEmailServiceMock(): EmailServiceMock {
  const sendVerificationEmail = vi.fn(async (_email: string, token: string) => {
    lastVerificationToken = token;
  });

  const sendEmailChangeVerification = vi.fn(
    async (_newEmail: string, token: string) => {
      lastVerificationToken = token;
    },
  );

  const sendPasswordResetEmail = vi.fn(
    async (_email: string, token: string) => {
      lastPasswordResetToken = token;
    },
  );

  const sendPasswordChangedEmail = vi.fn(async (_email: string) => {});

  return {
    sendVerificationEmail,
    sendEmailChangeVerification,
    sendPasswordResetEmail,
    sendPasswordChangedEmail,
    getLastVerificationToken: () => lastVerificationToken,
    getLastPasswordResetToken: () => lastPasswordResetToken,
    reset: () => {
      lastVerificationToken = null;
      lastPasswordResetToken = null;
      sendVerificationEmail.mockClear();
      sendEmailChangeVerification.mockClear();
      sendPasswordResetEmail.mockClear();
      sendPasswordChangedEmail.mockClear();
    },
  };
}

let emailServiceMock: EmailServiceMock | null = null;

export function getEmailServiceMock(): EmailServiceMock {
  if (!emailServiceMock) {
    emailServiceMock = createEmailServiceMock();
  }
  return emailServiceMock;
}

export function resetAllMocks() {
  if (emailServiceMock) {
    emailServiceMock.reset();
  }
  lastVerificationToken = null;
  lastPasswordResetToken = null;
}

export function mockImageProvider() {
  return {
    name: 'test',
    validateDimensions: vi.fn(() => true),
    getSupportedDimensions: vi.fn(() => [
      { width: 1024, height: 1024 },
      { width: 512, height: 512 },
    ]),
    generateImage: vi.fn(async () => ({
      success: true,
      imageData: Buffer.from('fake-image'),
    })),
  };
}
