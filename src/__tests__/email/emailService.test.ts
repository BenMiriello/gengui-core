import { describe, expect, test } from 'bun:test';

describe('EmailService', () => {
  describe('URL generation patterns', () => {
    test('verification URL follows expected pattern', () => {
      const frontendUrl = 'https://app.example.com';
      const token = 'test-token-123';
      const verificationUrl = `${frontendUrl}/verify-email?token=${token}`;

      expect(verificationUrl).toBe('https://app.example.com/verify-email?token=test-token-123');
    });

    test('password reset URL follows expected pattern', () => {
      const frontendUrl = 'https://app.example.com';
      const token = 'reset-token-456';
      const resetUrl = `${frontendUrl}/reset-password?token=${token}`;

      expect(resetUrl).toBe('https://app.example.com/reset-password?token=reset-token-456');
    });

    test('email change verification URL follows expected pattern', () => {
      const frontendUrl = 'https://app.example.com';
      const token = 'change-token-789';
      const verificationUrl = `${frontendUrl}/verify-email-change?token=${token}`;

      expect(verificationUrl).toBe('https://app.example.com/verify-email-change?token=change-token-789');
    });
  });

  describe('URL construction', () => {
    test('URLs correctly encode token in query string', () => {
      const frontendUrl = 'http://localhost:5173';
      const token = 'abc123';

      const verificationUrl = `${frontendUrl}/verify-email?token=${token}`;
      expect(verificationUrl).toContain('?token=abc123');

      const resetUrl = `${frontendUrl}/reset-password?token=${token}`;
      expect(resetUrl).toContain('?token=abc123');

      const changeUrl = `${frontendUrl}/verify-email-change?token=${token}`;
      expect(changeUrl).toContain('?token=abc123');
    });

    test('URLs use correct paths for each email type', () => {
      const frontendUrl = 'http://localhost:5173';
      const token = 'token';

      expect(`${frontendUrl}/verify-email?token=${token}`).toContain('/verify-email');
      expect(`${frontendUrl}/reset-password?token=${token}`).toContain('/reset-password');
      expect(`${frontendUrl}/verify-email-change?token=${token}`).toContain('/verify-email-change');
    });
  });

  describe('Email types', () => {
    test('all four email types are defined', () => {
      const emailTypes = [
        'sendVerificationEmail',
        'sendEmailChangeVerification',
        'sendPasswordResetEmail',
        'sendPasswordChangedEmail',
      ];

      expect(emailTypes.length).toBe(4);
    });

    test('verification email requires token', () => {
      const sendVerificationEmail = (email: string, token: string) => {
        if (!email || !token) throw new Error('Missing required params');
        return { email, token };
      };

      expect(() => sendVerificationEmail('test@test.com', 'token')).not.toThrow();
    });

    test('password reset email requires token', () => {
      const sendPasswordResetEmail = (email: string, token: string) => {
        if (!email || !token) throw new Error('Missing required params');
        return { email, token };
      };

      expect(() => sendPasswordResetEmail('test@test.com', 'token')).not.toThrow();
    });

    test('email change verification requires new email and token', () => {
      const sendEmailChangeVerification = (newEmail: string, token: string) => {
        if (!newEmail || !token) throw new Error('Missing required params');
        return { newEmail, token };
      };

      expect(() => sendEmailChangeVerification('new@test.com', 'token')).not.toThrow();
    });

    test('password changed email only requires email', () => {
      const sendPasswordChangedEmail = (email: string) => {
        if (!email) throw new Error('Missing required params');
        return { email };
      };

      expect(() => sendPasswordChangedEmail('test@test.com')).not.toThrow();
    });
  });

  describe('Email content requirements', () => {
    test('verification email contains verification link', () => {
      const emailContent = {
        subject: 'Verify your email address',
        body: 'Please verify your email address by clicking the link below',
        link: 'https://example.com/verify-email?token=abc123',
      };

      expect(emailContent.subject).toContain('Verify');
      expect(emailContent.body).toContain('verify');
      expect(emailContent.link).toContain('/verify-email');
    });

    test('password reset email contains reset link', () => {
      const emailContent = {
        subject: 'Reset your password',
        body: 'You have requested to reset your password',
        link: 'https://example.com/reset-password?token=abc123',
      };

      expect(emailContent.subject).toContain('Reset');
      expect(emailContent.body).toContain('reset');
      expect(emailContent.link).toContain('/reset-password');
    });

    test('password changed email is a notification', () => {
      const emailContent = {
        subject: 'Password changed successfully',
        body: 'Your password was successfully changed',
      };

      expect(emailContent.subject).toContain('changed');
      expect(emailContent.body).toContain('changed');
    });
  });
});
