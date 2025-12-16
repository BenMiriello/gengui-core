import { db } from '../config/database';
import { documents, documentVersions } from '../models/schema';
import { eq, desc, sql } from 'drizzle-orm';
import { NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';
import { diff_match_patch } from 'diff-match-patch';

const dmp = new diff_match_patch();

export class DocumentVersionsService {
  async createVersion(
    documentId: string,
    previousContent: string,
    newContent: string,
    userId: string | null,
    options?: {
      parentVersionId?: string | null;
      lineNumber?: number | null;
      charPosition?: number | null;
      changeType?: 'add' | 'remove' | 'replace';
    }
  ) {
    const patches = dmp.patch_make(previousContent, newContent);
    const diff = dmp.patch_toText(patches);

    const [version] = await db
      .insert(documentVersions)
      .values({
        documentId,
        diff,
        createdBy: userId,
        parentVersionId: options?.parentVersionId ?? null,
        lineNumber: options?.lineNumber ?? null,
        charPosition: options?.charPosition ?? null,
        changeType: options?.changeType ?? 'replace',
      })
      .returning();

    logger.info({ documentId, versionId: version.id, parentVersionId: options?.parentVersionId }, 'Document version created');

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

  async getChildren(versionId: string) {
    const result = await db.execute<{
      id: string;
      document_id: string;
      diff: string;
      parent_version_id: string | null;
      line_number: number | null;
      char_position: number | null;
      change_type: 'add' | 'remove' | 'replace';
      created_by: string | null;
      created_at: Date;
      most_recent_descendant_id: string;
      most_recent_descendant_created_at: Date;
    }>(sql`
      WITH RECURSIVE descendant_tree AS (
        SELECT
          id,
          parent_version_id,
          created_at,
          id as root_child_id
        FROM document_versions
        WHERE parent_version_id = ${versionId}

        UNION ALL

        SELECT
          dv.id,
          dv.parent_version_id,
          dv.created_at,
          dt.root_child_id
        FROM document_versions dv
        INNER JOIN descendant_tree dt ON dv.parent_version_id = dt.id
      ),
      max_timestamps AS (
        SELECT
          root_child_id,
          MAX(created_at) as most_recent_created_at
        FROM descendant_tree
        GROUP BY root_child_id
      ),
      most_recent_ids AS (
        SELECT DISTINCT ON (dt.root_child_id)
          dt.root_child_id,
          dt.id as most_recent_id,
          dt.created_at as most_recent_created_at
        FROM descendant_tree dt
        INNER JOIN max_timestamps mt
          ON dt.root_child_id = mt.root_child_id
          AND dt.created_at = mt.most_recent_created_at
        ORDER BY dt.root_child_id, dt.created_at DESC
      )
      SELECT
        dv.*,
        mri.most_recent_id as most_recent_descendant_id,
        mri.most_recent_created_at as most_recent_descendant_created_at
      FROM document_versions dv
      INNER JOIN most_recent_ids mri ON dv.id = mri.root_child_id
      WHERE dv.parent_version_id = ${versionId}
      ORDER BY mri.most_recent_created_at DESC
    `);

    return result.map((row: any) => ({
      id: row.id,
      documentId: row.document_id,
      diff: row.diff,
      parentVersionId: row.parent_version_id,
      lineNumber: row.line_number,
      charPosition: row.char_position,
      changeType: row.change_type,
      createdBy: row.created_by,
      createdAt: typeof row.created_at === 'string' ? row.created_at : row.created_at.toISOString(),
      mostRecentDescendant: {
        id: row.most_recent_descendant_id,
        createdAt: typeof row.most_recent_descendant_created_at === 'string'
          ? row.most_recent_descendant_created_at
          : row.most_recent_descendant_created_at.toISOString(),
      },
    }));
  }

  async getPathToRoot(versionId: string): Promise<typeof documentVersions.$inferSelect[]> {
    const path: (typeof documentVersions.$inferSelect)[] = [];
    let currentVersionId: string | null = versionId;

    while (currentVersionId) {
      const [version] = await db
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.id, currentVersionId))
        .limit(1);

      if (!version) {
        throw new NotFoundError('Version not found in path');
      }

      path.unshift(version);
      currentVersionId = version.parentVersionId;
    }

    return path;
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

    const path = await this.getPathToRoot(targetVersionId);

    if (path.length === 0) {
      return '';
    }

    const firstVersion = path[0];
    const patches = dmp.patch_fromText(firstVersion.diff);
    let content = dmp.patch_apply(patches, '')[0];

    for (let i = 1; i < path.length; i++) {
      const version = path[i];
      const versionPatches = dmp.patch_fromText(version.diff);
      content = dmp.patch_apply(versionPatches, content)[0];
    }

    return content;
  }
}

export const documentVersionsService = new DocumentVersionsService();
