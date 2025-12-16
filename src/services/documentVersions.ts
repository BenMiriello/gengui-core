import { db } from '../config/database';
import { documents, documentVersions } from '../models/schema';
import { eq, desc } from 'drizzle-orm';
import { NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';
import { diff_match_patch } from 'diff-match-patch';

const dmp = new diff_match_patch();

export class DocumentVersionsService {
  async createVersion(documentId: string, previousContent: string, newContent: string, userId: string | null) {
    const patches = dmp.patch_make(previousContent, newContent);
    const diff = dmp.patch_toText(patches);

    const [version] = await db
      .insert(documentVersions)
      .values({
        documentId,
        diff,
        createdBy: userId,
      })
      .returning();

    logger.info({ documentId, versionId: version.id }, 'Document version created');

    return version;
  }

  async list(documentId: string) {
    const versions = await db
      .select({
        id: documentVersions.id,
        documentId: documentVersions.documentId,
        createdBy: documentVersions.createdBy,
        createdAt: documentVersions.createdAt,
      })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId))
      .orderBy(desc(documentVersions.createdAt));

    return versions;
  }

  async get(versionId: string, documentId: string) {
    const [version] = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.id, versionId))
      .limit(1);

    if (!version || version.documentId !== documentId) {
      throw new NotFoundError('Version not found');
    }

    return version;
  }

  async reconstructContent(documentId: string, targetVersionId: string): Promise<string> {
    const [document] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);

    if (!document) {
      throw new NotFoundError('Document not found');
    }

    const allVersions = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId))
      .orderBy(documentVersions.createdAt);

    if (allVersions.length === 0) {
      return document.content;
    }

    const firstVersion = allVersions[0];
    const patches = dmp.patch_fromText(firstVersion.diff);
    let content = dmp.patch_apply(patches, '')[0];

    for (let i = 1; i < allVersions.length; i++) {
      const version = allVersions[i];
      const versionPatches = dmp.patch_fromText(version.diff);
      content = dmp.patch_apply(versionPatches, content)[0];

      if (version.id === targetVersionId) {
        return content;
      }
    }

    if (allVersions[allVersions.length - 1].id === targetVersionId) {
      return content;
    }

    throw new NotFoundError('Version not found');
  }
}

export const documentVersionsService = new DocumentVersionsService();
