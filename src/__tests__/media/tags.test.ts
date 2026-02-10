import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  closeDb,
  createTestMedia,
  createTestTag,
  createVerifiedUser,
  getMediaTags,
  getTagsForUser,
  resetMediaCounter,
  resetTagCounter,
  resetUserCounter,
  truncateAll,
} from '../helpers';
import { clearRedisStore, clearStorageData, startTestServer, stopTestServer } from '../helpers/testApp';

describe('Media Tags', () => {
  let baseUrl: string;

  beforeAll(async () => {
    const server = await startTestServer();
    baseUrl = server.baseUrl;
  });

  afterAll(async () => {
    await stopTestServer();
    await closeDb();
  });

  beforeEach(async () => {
    await truncateAll();
    resetUserCounter();
    resetMediaCounter();
    resetTagCounter();
    clearRedisStore();
    clearStorageData();
  });

  describe('POST /tags', () => {
    test('creates a new tag', async () => {
      const { user } = await createVerifiedUser();

      const res = await fetch(`${baseUrl}/api/tags`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': user.id,
        },
        body: JSON.stringify({ name: 'My Tag' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.id).toBeDefined();
      expect(body.name).toBe('My Tag');

      const tags = await getTagsForUser(user.id);
      expect(tags.length).toBe(1);
    });

    test('returns 400 when name is missing', async () => {
      const { user } = await createVerifiedUser();

      const res = await fetch(`${baseUrl}/api/tags`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': user.id,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_INPUT');
    });

    test('requires X-User-Id header', async () => {
      const res = await fetch(`${baseUrl}/api/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Test' }),
      });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /tags', () => {
    test('returns empty array when user has no tags', async () => {
      const { user } = await createVerifiedUser();

      const res = await fetch(`${baseUrl}/api/tags`, {
        headers: { 'X-User-Id': user.id },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tags).toEqual([]);
      expect(body.count).toBe(0);
    });

    test('returns user tags ordered by name', async () => {
      const { user } = await createVerifiedUser();
      await createTestTag(user.id, 'Zebra');
      await createTestTag(user.id, 'Apple');

      const res = await fetch(`${baseUrl}/api/tags`, {
        headers: { 'X-User-Id': user.id },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tags.length).toBe(2);
      expect(body.tags[0].name).toBe('Apple');
      expect(body.tags[1].name).toBe('Zebra');
    });

    test('does not return other users tags', async () => {
      const { user: user1 } = await createVerifiedUser();
      const { user: user2 } = await createVerifiedUser();
      await createTestTag(user1.id, 'User1 Tag');
      await createTestTag(user2.id, 'User2 Tag');

      const res = await fetch(`${baseUrl}/api/tags`, {
        headers: { 'X-User-Id': user1.id },
      });

      const body = await res.json();
      expect(body.tags.length).toBe(1);
      expect(body.tags[0].name).toBe('User1 Tag');
    });

    test('requires X-User-Id header', async () => {
      const res = await fetch(`${baseUrl}/api/tags`);
      expect(res.status).toBe(401);
    });
  });

  describe('POST /media/:id/tags', () => {
    test('adds tag to media', async () => {
      const { user } = await createVerifiedUser();
      const media = await createTestMedia(user.id);
      const tag = await createTestTag(user.id, 'Nature');

      const res = await fetch(`${baseUrl}/api/media/${media.id}/tags`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': user.id,
        },
        body: JSON.stringify({ tagId: tag.id }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.mediaId).toBe(media.id);
      expect(body.tagId).toBe(tag.id);

      const mediaTags = await getMediaTags(media.id);
      expect(mediaTags.length).toBe(1);
      expect(mediaTags[0].id).toBe(tag.id);
    });

    test('returns 400 when tagId is missing', async () => {
      const { user } = await createVerifiedUser();
      const media = await createTestMedia(user.id);

      const res = await fetch(`${baseUrl}/api/media/${media.id}/tags`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': user.id,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_INPUT');
    });

    test('returns 404 for non-existent media', async () => {
      const { user } = await createVerifiedUser();
      const tag = await createTestTag(user.id);

      const res = await fetch(`${baseUrl}/api/media/00000000-0000-0000-0000-000000000000/tags`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': user.id,
        },
        body: JSON.stringify({ tagId: tag.id }),
      });

      expect(res.status).toBe(404);
    });

    test('returns 404 for non-existent tag', async () => {
      const { user } = await createVerifiedUser();
      const media = await createTestMedia(user.id);

      const res = await fetch(`${baseUrl}/api/media/${media.id}/tags`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': user.id,
        },
        body: JSON.stringify({ tagId: '00000000-0000-0000-0000-000000000000' }),
      });

      expect(res.status).toBe(404);
    });

    test('returns 404 for other users media', async () => {
      const { user: user1 } = await createVerifiedUser();
      const { user: user2 } = await createVerifiedUser();
      const media = await createTestMedia(user2.id);
      const tag = await createTestTag(user1.id);

      const res = await fetch(`${baseUrl}/api/media/${media.id}/tags`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': user1.id,
        },
        body: JSON.stringify({ tagId: tag.id }),
      });

      expect(res.status).toBe(404);
    });

    test('returns 409 when tag already on media', async () => {
      const { user } = await createVerifiedUser();
      const media = await createTestMedia(user.id);
      const tag = await createTestTag(user.id);

      await fetch(`${baseUrl}/api/media/${media.id}/tags`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': user.id,
        },
        body: JSON.stringify({ tagId: tag.id }),
      });

      const res = await fetch(`${baseUrl}/api/media/${media.id}/tags`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': user.id,
        },
        body: JSON.stringify({ tagId: tag.id }),
      });

      expect(res.status).toBe(409);
    });

    test('requires X-User-Id header', async () => {
      const res = await fetch(`${baseUrl}/api/media/some-id/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagId: 'some-tag' }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /media/:id/tags/:tagId', () => {
    test('removes tag from media', async () => {
      const { user } = await createVerifiedUser();
      const media = await createTestMedia(user.id);
      const tag = await createTestTag(user.id);

      await fetch(`${baseUrl}/api/media/${media.id}/tags`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': user.id,
        },
        body: JSON.stringify({ tagId: tag.id }),
      });

      const res = await fetch(`${baseUrl}/api/media/${media.id}/tags/${tag.id}`, {
        method: 'DELETE',
        headers: { 'X-User-Id': user.id },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message).toBe('Tag removed from media');

      const mediaTags = await getMediaTags(media.id);
      expect(mediaTags.length).toBe(0);
    });

    test('returns 404 for non-existent media', async () => {
      const { user } = await createVerifiedUser();
      const tag = await createTestTag(user.id);

      const res = await fetch(`${baseUrl}/api/media/00000000-0000-0000-0000-000000000000/tags/${tag.id}`, {
        method: 'DELETE',
        headers: { 'X-User-Id': user.id },
      });

      expect(res.status).toBe(404);
    });

    test('returns 404 for non-existent tag', async () => {
      const { user } = await createVerifiedUser();
      const media = await createTestMedia(user.id);

      const res = await fetch(`${baseUrl}/api/media/${media.id}/tags/00000000-0000-0000-0000-000000000000`, {
        method: 'DELETE',
        headers: { 'X-User-Id': user.id },
      });

      expect(res.status).toBe(404);
    });

    test('returns 404 when tag not on media', async () => {
      const { user } = await createVerifiedUser();
      const media = await createTestMedia(user.id);
      const tag = await createTestTag(user.id);

      const res = await fetch(`${baseUrl}/api/media/${media.id}/tags/${tag.id}`, {
        method: 'DELETE',
        headers: { 'X-User-Id': user.id },
      });

      expect(res.status).toBe(404);
    });

    test('requires X-User-Id header', async () => {
      const res = await fetch(`${baseUrl}/api/media/some-id/tags/some-tag`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(401);
    });
  });
});
