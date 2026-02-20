import type { Transporter } from 'nodemailer';
import nodemailer from 'nodemailer';
import { logger } from '../utils/logger';

export class EmailService {
  private transporter: Transporter | null = null;
  private enabled: boolean = false;
  private devMode: boolean = false;

  constructor() {
    const {
      NODE_ENV,
      SMTP_HOST,
      SMTP_PORT,
      SMTP_USER,
      SMTP_PASSWORD,
      SMTP_FROM,
    } = process.env;

    if (SMTP_HOST === 'localhost' && SMTP_PORT === '1025') {
      this.transporter = nodemailer.createTransport({
        host: 'localhost',
        port: 1025,
        ignoreTLS: true,
      });
      this.enabled = true;
      this.devMode = true;
      logger.info('Email service using Mailhog at http://localhost:8025');
      return;
    }

    if (NODE_ENV === 'development') {
      this.enabled = false;
      this.devMode = true;
      logger.warn(
        'Email service disabled - verification URLs will be logged to console',
      );
      logger.warn(
        'To enable local email testing, run: brew install mailhog && mailhog',
      );
      return;
    }

    if (!SMTP_HOST || !SMTP_PORT || !SMTP_FROM) {
      throw new Error(
        'SMTP configuration required in production (SMTP_HOST, SMTP_PORT, SMTP_FROM)',
      );
    }

    this.transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth:
        SMTP_USER && SMTP_PASSWORD
          ? {
              user: SMTP_USER,
              pass: SMTP_PASSWORD,
            }
          : undefined,
    });

    this.enabled = true;
    this.devMode = false;
    logger.info('Email service initialized for production');
  }

  async sendVerificationEmail(email: string, token: string): Promise<void> {
    const frontendUrl = process.env.FRONTEND_URL;
    if (!frontendUrl) {
      throw new Error('FRONTEND_URL required for email links');
    }
    const verificationUrl = `${frontendUrl}/verify-email?token=${token}`;

    if (!this.enabled || !this.transporter) {
      logger.info(
        { email, verificationUrl },
        '📧 DEV MODE - Copy this URL to verify email:',
      );
      console.log('\n🔗 Email Verification URL:');
      console.log(`   ${verificationUrl}\n`);
      return;
    }

    await this.transporter.sendMail({
      from: process.env.SMTP_FROM || 'GenGui <noreply@localhost>',
      to: email,
      subject: 'Verify your email address',
      html: `
        <h1>Verify your email</h1>
        <p>Thank you for signing up! Please verify your email address by clicking the link below:</p>
        <p><a href="${verificationUrl}">${verificationUrl}</a></p>
        <p>This link will expire in 24 hours.</p>
        <p>If you did not create an account, you can safely ignore this email.</p>
      `,
      text: `
        Verify your email

        Thank you for signing up! Please verify your email address by clicking the link below:

        ${verificationUrl}

        This link will expire in 24 hours.

        If you did not create an account, you can safely ignore this email.
      `,
    });

    if (this.devMode) {
      logger.info(
        { email },
        '📧 Verification email sent to Mailhog - Check http://localhost:8025',
      );
    } else {
      logger.info({ email }, 'Verification email sent');
    }
  }

  async sendEmailChangeVerification(
    newEmail: string,
    token: string,
  ): Promise<void> {
    const frontendUrl = process.env.FRONTEND_URL;
    if (!frontendUrl) {
      throw new Error('FRONTEND_URL required for email links');
    }
    const verificationUrl = `${frontendUrl}/verify-email-change?token=${token}`;

    if (!this.enabled || !this.transporter) {
      logger.info(
        { newEmail, verificationUrl },
        '📧 DEV MODE - Copy this URL to verify email change:',
      );
      console.log('\n🔗 Email Change Verification URL:');
      console.log(`   ${verificationUrl}\n`);
      return;
    }

    await this.transporter.sendMail({
      from: process.env.SMTP_FROM || 'GenGui <noreply@localhost>',
      to: newEmail,
      subject: 'Verify your new email address',
      html: `
        <h1>Verify your new email address</h1>
        <p>You have requested to change your email address. Please verify your new email by clicking the link below:</p>
        <p><a href="${verificationUrl}">${verificationUrl}</a></p>
        <p>This link will expire in 24 hours.</p>
        <p>If you did not request this change, please contact support immediately.</p>
      `,
      text: `
        Verify your new email address

        You have requested to change your email address. Please verify your new email by clicking the link below:

        ${verificationUrl}

        This link will expire in 24 hours.

        If you did not request this change, please contact support immediately.
      `,
    });

    if (this.devMode) {
      logger.info(
        { newEmail },
        '📧 Email change verification sent to Mailhog - Check http://localhost:8025',
      );
    } else {
      logger.info({ newEmail }, 'Email change verification sent');
    }
  }

  async sendPasswordResetEmail(email: string, token: string): Promise<void> {
    const frontendUrl = process.env.FRONTEND_URL;
    if (!frontendUrl) {
      throw new Error('FRONTEND_URL required for email links');
    }
    const resetUrl = `${frontendUrl}/reset-password?token=${token}`;

    if (!this.enabled || !this.transporter) {
      logger.info(
        { email, resetUrl },
        '📧 DEV MODE - Copy this URL to reset password:',
      );
      console.log('\n🔗 Password Reset URL:');
      console.log(`   ${resetUrl}\n`);
      return;
    }

    await this.transporter.sendMail({
      from: process.env.SMTP_FROM || 'GenGui <noreply@localhost>',
      to: email,
      subject: 'Reset your password',
      html: `
        <h1>Reset your password</h1>
        <p>You have requested to reset your password. Click the link below to continue:</p>
        <p><a href="${resetUrl}">${resetUrl}</a></p>
        <p>This link will expire in 1 hour.</p>
        <p>If you did not request this reset, you can safely ignore this email.</p>
      `,
      text: `
        Reset your password

        You have requested to reset your password. Click the link below to continue:

        ${resetUrl}

        This link will expire in 1 hour.

        If you did not request this reset, you can safely ignore this email.
      `,
    });

    if (this.devMode) {
      logger.info(
        { email },
        '📧 Password reset email sent to Mailhog - Check http://localhost:8025',
      );
    } else {
      logger.info({ email }, 'Password reset email sent');
    }
  }

  async sendPasswordChangedEmail(email: string): Promise<void> {
    if (!this.enabled || !this.transporter) {
      logger.info(
        { email },
        '📧 DEV MODE - Password changed notification (email not sent)',
      );
      console.log('\n🔔 Password Changed Notification:');
      console.log(
        `   User ${email} changed their password at ${new Date().toISOString()}\n`,
      );
      return;
    }

    await this.transporter.sendMail({
      from: process.env.SMTP_FROM || 'GenGui <noreply@localhost>',
      to: email,
      subject: 'Password changed successfully',
      html: `
        <h1>Password changed</h1>
        <p>Your password was successfully changed on ${new Date().toLocaleString()}.</p>
        <p>If you did not make this change, please contact support immediately and reset your password.</p>
      `,
      text: `
        Password changed

        Your password was successfully changed on ${new Date().toLocaleString()}.

        If you did not make this change, please contact support immediately and reset your password.
      `,
    });

    if (this.devMode) {
      logger.info(
        { email },
        '📧 Password changed notification sent to Mailhog - Check http://localhost:8025',
      );
    } else {
      logger.info({ email }, 'Password changed notification sent');
    }
  }
}

export const emailService = new EmailService();
