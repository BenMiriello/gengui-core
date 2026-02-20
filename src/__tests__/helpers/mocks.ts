import { type Mock, mock } from 'bun:test';

interface EmailServiceMock {
  sendVerificationEmail: Mock<(email: string, token: string) => Promise<void>>;
  sendEmailChangeVerification: Mock<
    (newEmail: string, token: string) => Promise<void>
  >;
  sendPasswordResetEmail: Mock<(email: string, token: string) => Promise<void>>;
  sendPasswordChangedEmail: Mock<(email: string) => Promise<void>>;
  getLastVerificationToken: () => string | null;
  getLastPasswordResetToken: () => string | null;
  reset: () => void;
}

let lastVerificationToken: string | null = null;
let lastPasswordResetToken: string | null = null;

export function createEmailServiceMock(): EmailServiceMock {
  const sendVerificationEmail = mock(async (_email: string, token: string) => {
    lastVerificationToken = token;
  });

  const sendEmailChangeVerification = mock(
    async (_newEmail: string, token: string) => {
      lastVerificationToken = token;
    },
  );

  const sendPasswordResetEmail = mock(async (_email: string, token: string) => {
    lastPasswordResetToken = token;
  });

  const sendPasswordChangedEmail = mock(async (_email: string) => {});

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
    validateDimensions: mock(() => true),
    getSupportedDimensions: mock(() => [
      { width: 1024, height: 1024 },
      { width: 512, height: 512 },
    ]),
    generateImage: mock(async () => ({
      success: true,
      imageData: Buffer.from('fake-image'),
    })),
  };
}
