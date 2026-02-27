import { db } from '../../config/database';
import { contactSubmissions, users } from '../../models/schema';
import { eq, desc } from 'drizzle-orm';
import { emailService } from '../emailService';
import { logger } from '../../utils/logger';

export class ContactService {
  async submitContact(params: {
    userId?: string;
    email: string;
    subject: string;
    message: string;
    submissionType?: string;
    userAgent?: string;
    ipAddress?: string;
  }): Promise<typeof contactSubmissions.$inferSelect> {
    const {
      userId,
      email,
      subject,
      message,
      submissionType = 'contact',
      userAgent,
      ipAddress,
    } = params;

    const [submission] = await db
      .insert(contactSubmissions)
      .values({
        userId,
        email,
        subject,
        message,
        submissionType,
        status: 'pending',
        userAgent,
        ipAddress,
      })
      .returning();

    await this.notifyAdmins(submission);
    await this.sendAutoResponse(email, subject, message);

    return submission;
  }

  async notifyAdmins(
    submission: typeof contactSubmissions.$inferSelect,
  ): Promise<void> {
    const admins = await db
      .select()
      .from(users)
      .where(eq(users.role, 'admin'));

    const now = new Date();
    const hour = now.getHours();
    const shouldDelay = hour >= 21 || hour < 9;

    const adminEmails = admins.map(
      (admin: typeof users.$inferSelect) => admin.email,
    );

    if (adminEmails.length === 0) {
      logger.warn(
        { submissionId: submission.id },
        'No admin users found to notify',
      );
      return;
    }

    for (const adminEmail of adminEmails) {
      try {
        if (shouldDelay) {
          logger.info(
            { adminEmail, submissionId: submission.id, hour },
            'Delaying admin notification until 9am (quiet hours)',
          );
        }

        await emailService.sendContactNotification(adminEmail, {
          id: submission.id,
          email: submission.email,
          subject: submission.subject,
          message: submission.message,
          submissionType: submission.submissionType,
          createdAt: submission.createdAt,
        });
      } catch (error) {
        logger.error(
          { error, adminEmail, submissionId: submission.id },
          'Failed to send admin notification email',
        );
      }
    }

    logger.info(
      {
        submissionId: submission.id,
        submissionType: submission.submissionType,
        adminCount: adminEmails.length,
      },
      'Admin notifications sent',
    );
  }

  async sendAutoResponse(
    email: string,
    subject: string,
    message: string,
  ): Promise<void> {
    try {
      await emailService.sendContactAutoResponse(email, {
        subject,
        message,
      });

      logger.info({ to: email }, 'Auto-response sent');
    } catch (error) {
      logger.error(
        { error, to: email },
        'Failed to send auto-response email',
      );
    }
  }

  async listPending(): Promise<Array<typeof contactSubmissions.$inferSelect>> {
    return db
      .select()
      .from(contactSubmissions)
      .where(eq(contactSubmissions.status, 'pending'))
      .orderBy(desc(contactSubmissions.createdAt));
  }

  async markStatus(
    id: string,
    status: string,
    adminUserId: string,
    notes?: string,
  ): Promise<void> {
    await db
      .update(contactSubmissions)
      .set({
        status,
        respondedAt: new Date(),
        respondedBy: adminUserId,
        adminNotes: notes,
        updatedAt: new Date(),
      })
      .where(eq(contactSubmissions.id, id));
  }
}

export const contactService = new ContactService();
