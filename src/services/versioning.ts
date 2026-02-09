import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../config/database';
import { documents, documentVersions } from '../models/schema';
import { logger } from '../utils/logger';

export class VersioningService {
  async createVersion(documentId: string, yjsState: string, content: string): Promise<number> {
    return await db.transaction(async (tx) => {
      // Lock the document row to prevent race conditions
      const result = await tx.execute(
        sql`SELECT current_version FROM documents WHERE id = ${documentId} FOR UPDATE`
      );
      const currentVersion = (result[0]?.current_version as number) ?? 0;

      // Skip if content unchanged from previous version
      if (currentVersion > 0) {
        const [latestVersion] = await tx
          .select({ yjsState: documentVersions.yjsState, content: documentVersions.content })
          .from(documentVersions)
          .where(
            and(
              eq(documentVersions.documentId, documentId),
              eq(documentVersions.versionNumber, currentVersion)
            )
          )
          .limit(1);

        if (latestVersion?.content === content && latestVersion?.yjsState === yjsState) {
          logger.debug({ documentId, versionNumber: currentVersion }, 'Skipped duplicate version');
          return currentVersion;
        }
      }

      const newVersionNumber = currentVersion + 1;

      await tx.insert(documentVersions).values({
        documentId,
        versionNumber: newVersionNumber,
        yjsState,
        content,
      });

      await tx
        .update(documents)
        .set({
          currentVersion: newVersionNumber,
          yjsState,
          updatedAt: new Date(),
        })
        .where(eq(documents.id, documentId));

      logger.debug({ documentId, versionNumber: newVersionNumber }, 'Version created');

      return newVersionNumber;
    });
  }

  async getVersions(documentId: string, limit = 50) {
    const versions = await db
      .select({
        id: documentVersions.id,
        versionNumber: documentVersions.versionNumber,
        createdAt: documentVersions.createdAt,
      })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId))
      .orderBy(desc(documentVersions.versionNumber))
      .limit(limit);

    return versions;
  }

  async getVersion(documentId: string, versionNumber: number) {
    const [version] = await db
      .select()
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.documentId, documentId),
          eq(documentVersions.versionNumber, versionNumber)
        )
      )
      .limit(1);

    return version ?? null;
  }

  async getCurrentVersionNumber(documentId: string): Promise<number> {
    const [doc] = await db
      .select({ currentVersion: documents.currentVersion })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);

    return doc?.currentVersion ?? 0;
  }
}

export const versioningService = new VersioningService();
