import type { Transporter } from 'nodemailer';
import nodemailer from 'nodemailer';
import { APP_NAME } from '../config/appConfig';
import { logger } from '../utils/logger';

const WELCOME_MESSAGE = `We are on a mission to build the most insightful and creator-friendly narrative writing tool possible. ${APP_NAME || 'our app'} is in the early stages and we are working hard to improve it, so we are very grateful for your interest and support. Any feedback you can provide is welcome.

Please tell us a little bit about yourself, your interests and your needs. We are seeking a diverse group of writers and creators to help us improve our product and build our community.`;

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
      from: process.env.SMTP_FROM || `${APP_NAME} <noreply@localhost>`,
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
      from: process.env.SMTP_FROM || `${APP_NAME} <noreply@localhost>`,
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
      from: process.env.SMTP_FROM || `${APP_NAME} <noreply@localhost>`,
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
      from: process.env.SMTP_FROM || `${APP_NAME} <noreply@localhost>`,
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

  async sendContactNotification(
    adminEmail: string,
    submission: {
      id: string;
      email: string;
      subject: string;
      message: string;
      submissionType: string;
      createdAt: Date;
    },
  ): Promise<void> {
    if (!this.enabled || !this.transporter) {
      logger.info(
        { adminEmail, submissionId: submission.id },
        '📧 DEV MODE - Contact notification (email not sent)',
      );
      console.log('\n🔔 New Contact Form Submission:');
      console.log(`   From: ${submission.email}`);
      console.log(`   Subject: ${submission.subject}`);
      console.log(`   Type: ${submission.submissionType}`);
      console.log(`   ID: ${submission.id}\n`);
      return;
    }

    await this.transporter.sendMail({
      from: process.env.SMTP_FROM || `${APP_NAME} <noreply@localhost>`,
      to: adminEmail,
      subject: `New ${submission.submissionType}: ${submission.subject}`,
      html: `
        <h1>New Contact Form Submission</h1>

        <div style="background-color: #f5f5f5; padding: 20px; margin: 20px 0; border-left: 4px solid #4CAF50;">
          <p><strong>From:</strong> ${submission.email}</p>
          <p><strong>Type:</strong> ${submission.submissionType}</p>
          <p><strong>Subject:</strong> ${submission.subject}</p>
          <p><strong>Submitted:</strong> ${submission.createdAt.toLocaleString()}</p>
          <p><strong>Submission ID:</strong> ${submission.id}</p>
        </div>

        <h2>Message:</h2>
        <div style="background-color: #ffffff; padding: 15px; border: 1px solid #ddd; white-space: pre-wrap;">
${submission.message}
        </div>

        <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">

        <p style="color: #666; font-size: 14px;">
          To respond, reply to this email or visit the admin dashboard.
        </p>
      `,
      text: `
New Contact Form Submission

From: ${submission.email}
Type: ${submission.submissionType}
Subject: ${submission.subject}
Submitted: ${submission.createdAt.toLocaleString()}
Submission ID: ${submission.id}

---

Message:

${submission.message}

---

To respond, reply to this email or visit the admin dashboard.
      `,
      replyTo: submission.email,
    });

    if (this.devMode) {
      logger.info(
        { adminEmail, submissionId: submission.id },
        '📧 Contact notification sent to Mailhog - Check http://localhost:8025',
      );
    } else {
      logger.info(
        { adminEmail, submissionId: submission.id },
        'Contact notification sent',
      );
    }
  }

  async sendContactAutoResponse(
    userEmail: string,
    submission: {
      subject: string;
      message: string;
    },
  ): Promise<void> {
    if (!this.enabled || !this.transporter) {
      logger.info(
        { userEmail },
        '📧 DEV MODE - Contact auto-response (email not sent)',
      );
      console.log('\n🔔 Contact Auto-Response:');
      console.log(`   To: ${userEmail}\n`);
      return;
    }

    await this.transporter.sendMail({
      from: process.env.SMTP_FROM || `${APP_NAME} <noreply@localhost>`,
      to: userEmail,
      subject: `Thanks for contacting ${APP_NAME || 'us'}!`,
      html: `
        <h1>Thank you for reaching out!</h1>

        <p>We've received your message and will respond within 24 hours.</p>

        <div style="background-color: #f5f5f5; padding: 20px; margin: 20px 0; border-left: 4px solid #4CAF50;">
          <h3 style="margin-top: 0;">Your message:</h3>
          <p><strong>Subject:</strong> ${submission.subject}</p>
          <div style="white-space: pre-wrap; margin-top: 10px;">
${submission.message}
          </div>
        </div>

        <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">

        <div style="color: #666; font-size: 14px; white-space: pre-line;">
${WELCOME_MESSAGE}
        </div>

        <p style="margin-top: 30px;">
          Best regards,<br>
          ${APP_NAME || 'Our'} Team
        </p>
      `,
      text: `
Thank you for reaching out!

We've received your message and will respond within 24 hours.

---

Your message:

Subject: ${submission.subject}

${submission.message}

---

${WELCOME_MESSAGE}

Best regards,
${APP_NAME ? `The ${APP_NAME} Team` : 'Our Team'}
      `,
    });

    if (this.devMode) {
      logger.info(
        { userEmail },
        '📧 Contact auto-response sent to Mailhog - Check http://localhost:8025',
      );
    } else {
      logger.info({ userEmail }, 'Contact auto-response sent');
    }
  }

  async sendAccountDeletionInitiated(
    email: string,
    scheduledDeletionAt: Date,
  ): Promise<void> {
    const formattedDate = scheduledDeletionAt.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    if (!this.enabled || !this.transporter) {
      logger.info(
        { email, scheduledDeletionAt: scheduledDeletionAt.toISOString() },
        '📧 DEV MODE - Account deletion initiated (email not sent)',
      );
      console.log('\n🔔 Account Deletion Initiated:');
      console.log(`   User: ${email}`);
      console.log(`   Scheduled for: ${formattedDate}\n`);
      return;
    }

    await this.transporter.sendMail({
      from: process.env.SMTP_FROM || `${APP_NAME} <noreply@localhost>`,
      to: email,
      subject: 'Your account is scheduled for deletion',
      html: `
        <h1>Account deletion scheduled</h1>
        <p>We've received your request to delete your account.</p>
        <p>Your account and all associated data will be permanently deleted on <strong>${formattedDate}</strong>.</p>
        <h2>Changed your mind?</h2>
        <p>Simply log in to your account before the deletion date to cancel the request and keep your account.</p>
        <p>If you did not request this deletion, please log in immediately to secure your account.</p>
      `,
      text: `
Account deletion scheduled

We've received your request to delete your account.

Your account and all associated data will be permanently deleted on ${formattedDate}.

Changed your mind?
Simply log in to your account before the deletion date to cancel the request and keep your account.

If you did not request this deletion, please log in immediately to secure your account.
      `,
    });

    if (this.devMode) {
      logger.info(
        { email },
        '📧 Account deletion email sent to Mailhog - Check http://localhost:8025',
      );
    } else {
      logger.info({ email }, 'Account deletion email sent');
    }
  }

  async sendAccountDeletionReminder(
    email: string,
    scheduledDeletionAt: Date,
  ): Promise<void> {
    const formattedDate = scheduledDeletionAt.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const frontendUrl = process.env.FRONTEND_URL || '';
    const loginUrl = `${frontendUrl}/login`;

    if (!this.enabled || !this.transporter) {
      logger.info(
        { email, scheduledDeletionAt: scheduledDeletionAt.toISOString() },
        '📧 DEV MODE - Account deletion reminder (email not sent)',
      );
      console.log('\n🔔 Account Deletion Reminder:');
      console.log(`   User: ${email}`);
      console.log(`   Will be deleted: ${formattedDate}\n`);
      return;
    }

    await this.transporter.sendMail({
      from: process.env.SMTP_FROM || `${APP_NAME} <noreply@localhost>`,
      to: email,
      subject: 'Final reminder: Your account will be deleted tomorrow',
      html: `
        <h1>Final reminder</h1>
        <p>Your account is scheduled for permanent deletion on <strong>${formattedDate}</strong>.</p>
        <p>After this date, all your data will be permanently deleted and cannot be recovered.</p>
        <h2>Want to keep your account?</h2>
        <p><a href="${loginUrl}">Log in now</a> to cancel the deletion request.</p>
        <p>If you intended to delete your account, no action is needed.</p>
      `,
      text: `
Final reminder

Your account is scheduled for permanent deletion on ${formattedDate}.

After this date, all your data will be permanently deleted and cannot be recovered.

Want to keep your account?
Log in at ${loginUrl} to cancel the deletion request.

If you intended to delete your account, no action is needed.
      `,
    });

    if (this.devMode) {
      logger.info(
        { email },
        '📧 Account deletion reminder sent to Mailhog - Check http://localhost:8025',
      );
    } else {
      logger.info({ email }, 'Account deletion reminder sent');
    }
  }
}

export const emailService = new EmailService();
