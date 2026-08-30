import { applyD1Migrations, env, SELF, type D1Migration } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const base = 'https://review-engine.test/api/v1';

function authorized(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${testEnv.REVIEW_ADMIN_TOKEN}`);
  return SELF.fetch(`${base}${path}`, { ...init, headers });
}

async function jsonBody<T>(response: Response): Promise<T> {
  expect(response.headers.get('content-type')).toContain('application/json');
  return response.json<T>();
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe('Review Engine Worker', () => {
  it('provides public health and protects application data', async () => {
    const health = await SELF.fetch(`${base}/health/ready`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: 'ok' });

    const unauthorized = await SELF.fetch(`${base}/categories`);
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toMatchObject({ code: 'UNAUTHORIZED' });

    const oversizedSession = await SELF.fetch(`${base}/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'x'.repeat(9_000) }),
    });
    expect(oversizedSession.status).toBe(413);
    await expect(oversizedSession.json()).resolves.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('runs the category, review, R2 picture, comparison, and visibility workflow', async () => {
    const categoryResponse = await authorized('/categories', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Coffee', description: 'Beans and brews' }),
    });
    expect(categoryResponse.status).toBe(201);
    const category = await jsonBody<{ id: string; revision: number }>(categoryResponse);

    const draftResponse = await authorized(`/categories/${category.id}/template-versions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ criteria: [{
        name: 'Flavor', minValue: '0', maxValue: '10', stepValue: '1', position: 0, required: true,
      }], properties: [
        { id: '00000000-0000-0000-0000-000000000101', name: 'Roast notes', type: 'text', options: [], position: 0, required: true },
        { id: '00000000-0000-0000-0000-000000000102', name: 'Roast level', type: 'select', options: ['Light', 'Dark'], position: 1, required: true },
        { id: '00000000-0000-0000-0000-000000000103', name: 'Organic', type: 'checkbox', options: [], position: 2, required: false },
      ] }),
    });
    expect(draftResponse.status).toBe(201);
    const draft = await jsonBody<{ id: string; revision: number; criteria: Array<{ id: string }> }>(draftResponse);

    const publishedResponse = await authorized(`/template-versions/${draft.id}/publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: draft.revision }),
    });
    expect(publishedResponse.status).toBe(200);

    const entityResponse = await authorized('/entities', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoryId: category.id, name: 'Ethiopia Natural' }),
    });
    expect(entityResponse.status).toBe(201);
    const entity = await jsonBody<{ id: string }>(entityResponse);

    const reviewResponse = await authorized(`/entities/${entity.id}/reviews`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reviewedAt: new Date().toISOString(), scores: [{ criterionId: draft.criteria[0]!.id, tickIndex: 8 }],
        properties: [
          { propertyId: '00000000-0000-0000-0000-000000000101', value: 'Chocolate and caramel' },
          { propertyId: '00000000-0000-0000-0000-000000000102', value: 'Dark' },
          { propertyId: '00000000-0000-0000-0000-000000000103', value: true },
        ],
      }),
    });
    expect(reviewResponse.status).toBe(201);
    const createdReview = await jsonBody<{ id: string; revision: number; properties: Array<{ propertyId: string; value: string | boolean }> }>(reviewResponse);
    expect(createdReview.properties).toEqual(expect.arrayContaining([
      expect.objectContaining({ propertyId: '00000000-0000-0000-0000-000000000101', value: 'Chocolate and caramel' }),
      expect.objectContaining({ propertyId: '00000000-0000-0000-0000-000000000102', value: 'Dark' }),
      expect.objectContaining({ propertyId: '00000000-0000-0000-0000-000000000103', value: true }),
    ]));
    let review = createdReview;

    const correctionA = { reviewedAt: '2026-08-28T00:00:01.000Z', tickIndex: 6 };
    const correctionB = { reviewedAt: '2026-08-28T00:00:02.000Z', tickIndex: 7 };
    const concurrent = await Promise.all([correctionA, correctionB].map((correction) => authorized(`/reviews/${review.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reviewedAt: correction.reviewedAt,
        scores: [{ criterionId: draft.criteria[0]!.id, tickIndex: correction.tickIndex }],
        revision: review.revision,
      }),
    })));
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409]);
    const storedReviewResponse = await authorized(`/reviews/${review.id}`);
    const storedReview = await jsonBody<{
      id: string; revision: number; reviewedAt: string; scores: Array<{ tickIndex: number }>; properties: Array<{ propertyId: string; value: string | boolean }>;
    }>(storedReviewResponse);
    const expectedPair = [correctionA, correctionB].find((correction) => correction.reviewedAt === storedReview.reviewedAt);
    expect(expectedPair).toBeDefined();
    expect(storedReview.scores[0]!.tickIndex).toBe(expectedPair!.tickIndex);
    review = storedReview;

    const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const lengthlessPicture = await authorized(
      `/reviews/${review.id}/pictures?revision=${review.revision}&fileName=proof.png`,
      { method: 'POST', headers: { 'Content-Type': 'image/png' } },
    );
    expect(lengthlessPicture.status).toBe(411);
    await expect(lengthlessPicture.json()).resolves.toMatchObject({ code: 'LENGTH_REQUIRED' });
    const pictureResponse = await authorized(
      `/reviews/${review.id}/pictures?revision=${review.revision}&fileName=proof.png`,
      { method: 'POST', headers: { 'Content-Type': 'image/png', 'Content-Length': String(pngHeader.byteLength) }, body: pngHeader },
    );
    expect(pictureResponse.status).toBe(201);
    let withPicture = await jsonBody<{ revision: number; pictures: Array<{ id: string; contentType: string }> }>(pictureResponse);
    expect(withPicture.pictures).toHaveLength(1);
    expect(withPicture.pictures[0]!.contentType).toBe('image/png');

    const content = await authorized(`/reviews/${review.id}/pictures/${withPicture.pictures[0]!.id}`);
    expect(content.status).toBe(200);
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(pngHeader);

    const deletedPictureResponse = await authorized(
      `/reviews/${review.id}/pictures/${withPicture.pictures[0]!.id}?revision=${withPicture.revision}`,
      { method: 'DELETE' },
    );
    expect(deletedPictureResponse.status).toBe(200);
    const withoutPicture = await jsonBody<{ revision: number; pictures: unknown[] }>(deletedPictureResponse);
    expect(withoutPicture.pictures).toHaveLength(0);
    await expect(testEnv.DB.prepare('SELECT COUNT(*) AS count FROM r2_deletion').first<number>('count')).resolves.toBe(0);

    const replacementPictureResponse = await authorized(
      `/reviews/${review.id}/pictures?revision=${withoutPicture.revision}&fileName=proof.png`,
      { method: 'POST', headers: { 'Content-Type': 'image/png', 'Content-Length': String(pngHeader.byteLength) }, body: pngHeader },
    );
    expect(replacementPictureResponse.status).toBe(201);
    withPicture = await jsonBody<{ revision: number; pictures: Array<{ id: string; contentType: string }> }>(replacementPictureResponse);

    const finalizedResponse = await authorized(`/reviews/${review.id}/finalize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: withPicture.revision }),
    });
    expect(finalizedResponse.status).toBe(200);
    const finalized = await jsonBody<{ revision: number; status: string }>(finalizedResponse);
    expect(finalized.status).toBe('final');

    const comparison = await authorized(`/comparisons?categoryId=${category.id}&entityId=${entity.id}&aggregation=latest`);
    expect(comparison.status).toBe(200);
    await expect(comparison.json()).resolves.toMatchObject({
      categoryId: category.id,
      entities: [{ entityId: entity.id, reviewCount: 1 }],
    });

    const hiddenResponse = await authorized(`/reviews/${review.id}/visibility`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden: true, revision: finalized.revision }),
    });
    expect(hiddenResponse.status).toBe(200);
    await expect(hiddenResponse.json()).resolves.toMatchObject({ hiddenAt: expect.any(String) });

    const exportResponse = await authorized('/exports', { method: 'POST' });
    expect(exportResponse.status).toBe(200);
    const exported = await exportResponse.json();
    const validationResponse = await authorized('/imports/validate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exported),
    });
    expect(validationResponse.status).toBe(200);
    await expect(validationResponse.json()).resolves.toMatchObject({ valid: true, formatVersion: '1.2' });
  });

  it('keeps entity moves and concurrent review creation consistent', async () => {
    const source = await testEnv.DB.prepare(
      `SELECT c.id AS category_id, c.active_template_version_id AS template_id, tc.criterion_id
       FROM category c JOIN template_criterion tc ON tc.template_version_id = c.active_template_version_id
       WHERE c.active_template_version_id IS NOT NULL LIMIT 1`,
    ).first<{ category_id: string; template_id: string; criterion_id: string }>();
    expect(source).not.toBeNull();
    const targetResponse = await authorized('/categories', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Move target' }),
    });
    const target = await jsonBody<{ id: string }>(targetResponse);
    const entityResponse = await authorized('/entities', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoryId: source!.category_id, name: 'Moving entity' }),
    });
    const entity = await jsonBody<{ id: string; revision: number }>(entityResponse);

    const [move, review] = await Promise.all([
      authorized(`/entities/${entity.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoryId: target.id, revision: entity.revision }),
      }),
      authorized(`/entities/${entity.id}/reviews`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reviewedAt: new Date().toISOString(),
          scores: [{ criterionId: source!.criterion_id, tickIndex: 1 }],
        }),
      }),
    ]);

    expect([move, review].filter((response) => response.ok)).toHaveLength(1);
    expect([move.status, review.status]).toContain(409);
    const mismatch = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM review r
       JOIN entity e ON e.id = r.entity_id
       JOIN template_version tv ON tv.id = r.template_version_id
       WHERE e.category_id <> tv.category_id`,
    ).first<number>('count');
    expect(mismatch).toBe(0);
  });

  it('compares 100 entities without exceeding D1 parameter limits', async () => {
    const source = await testEnv.DB.prepare(
      `SELECT c.id AS category_id, c.active_template_version_id AS template_id, tc.criterion_id
       FROM category c JOIN template_criterion tc ON tc.template_version_id = c.active_template_version_id
       WHERE c.active_template_version_id IS NOT NULL LIMIT 1`,
    ).first<{ category_id: string; template_id: string; criterion_id: string }>();
    expect(source).not.toBeNull();
    const entityIds: string[] = [];
    const statements: D1PreparedStatement[] = [];
    const timestamp = new Date().toISOString();
    for (let index = 0; index < 100; index += 1) {
      const entityId = crypto.randomUUID();
      const reviewId = crypto.randomUUID();
      entityIds.push(entityId);
      statements.push(
        testEnv.DB.prepare(
          `INSERT INTO entity(id, category_id, name, description, archived_at, created_at, updated_at, lock_version)
           VALUES (?, ?, ?, NULL, NULL, ?, ?, 0)`,
        ).bind(entityId, source!.category_id, `Scale entity ${index}`, timestamp, timestamp),
        testEnv.DB.prepare(
          `INSERT INTO review(id, entity_id, reviewer_id, template_version_id, reviewed_at, status,
           supersedes_review_id, created_at, updated_at, lock_version, hidden_at)
           VALUES (?, ?, '00000000-0000-0000-0000-000000000001', ?, ?, 'final', NULL, ?, ?, 0, NULL)`,
        ).bind(reviewId, entityId, source!.template_id, timestamp, timestamp, timestamp),
        testEnv.DB.prepare('INSERT INTO score(review_id, criterion_id, tick_index) VALUES (?, ?, 1)')
          .bind(reviewId, source!.criterion_id),
      );
    }
    await testEnv.DB.batch(statements);
    const query = new URLSearchParams({ categoryId: source!.category_id, aggregation: 'latest' });
    entityIds.forEach((id) => query.append('entityId', id));

    const response = await authorized(`/comparisons?${query}`);
    expect(response.status).toBe(200);
    const comparison = await jsonBody<{ entities: unknown[] }>(response);
    expect(comparison.entities).toHaveLength(100);
  });

  it('issues browser sessions and enforces same-origin writes', async () => {
    const response = await SELF.fetch(`${base}/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: testEnv.REVIEW_ADMIN_TOKEN }),
    });
    expect(response.status).toBe(204);
    const cookie = response.headers.get('set-cookie');
    expect(cookie).toContain('review_engine_session=');
    const credential = cookie!.split(';')[0]!;

    const read = await SELF.fetch(`${base}/categories`, { headers: { Cookie: credential } });
    expect(read.status).toBe(200);
    const rejectedWrite = await SELF.fetch(`${base}/categories`, {
      method: 'POST', headers: { Cookie: credential, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Blocked' }),
    });
    expect(rejectedWrite.status).toBe(403);
    await expect(rejectedWrite.json()).resolves.toMatchObject({ code: 'ORIGIN_MISMATCH' });
  });

  it('atomically prevents concurrent hierarchical relation cycles', async () => {
    const categoryResponse = await authorized('/categories', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hierarchy' }),
    });
    const category = await jsonBody<{ id: string }>(categoryResponse);
    const entities = await Promise.all(['Parent', 'Child'].map(async (name) => {
      const response = await authorized('/entities', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categoryId: category.id, name }),
      });
      expect(response.status).toBe(201);
      return jsonBody<{ id: string }>(response);
    }));
    const typeResponse = await authorized('/relation-types', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'contains', forwardLabel: 'contains', inverseLabel: 'belongs to', hierarchical: true,
      }),
    });
    const relationType = await jsonBody<{ id: string }>(typeResponse);

    const responses = await Promise.all([
      [entities[0]!.id, entities[1]!.id],
      [entities[1]!.id, entities[0]!.id],
    ].map(([sourceEntityId, targetEntityId]) => authorized('/relations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceEntityId, targetEntityId, relationTypeId: relationType.id }),
    })));

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const rejected = responses.find((response) => response.status === 409)!;
    await expect(rejected.json()).resolves.toMatchObject({ code: 'HIERARCHY_CYCLE' });
    const listed = await authorized(`/relations?relationTypeId=${relationType.id}`);
    await expect(listed.json()).resolves.toMatchObject({ items: [expect.any(Object)] });
    const traversal = await authorized(`/entities/${entities[0]!.id}/related?relationTypeId=${relationType.id}&maxDepth=5`);
    await expect(traversal.json()).resolves.toMatchObject({
      items: [{ entity: { id: entities[1]!.id }, depth: 1, path: [entities[0]!.id, entities[1]!.id] }],
    });
  });

  it('rejects revision-chain and hierarchical cycles during portable validation', async () => {
    const exportResponse = await authorized('/exports', { method: 'POST' });
    const exported = await exportResponse.json<Record<string, any>>();
    const review = exported.data.review[0];
    review.status = 'superseded';
    review.supersedes_review_id = review.id;
    const relation = exported.data.entity_relation[0];
    exported.data.entity_relation.push({
      ...relation,
      id: crypto.randomUUID(),
      source_entity_id: relation.target_entity_id,
      target_entity_id: relation.source_entity_id,
    });

    const validation = await authorized('/imports/validate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exported),
    });
    expect(validation.status).toBe(200);
    const result = await jsonBody<{ valid: boolean; errors: Array<{ code: string; message: string }> }>(validation);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('cycle') }),
      expect.objectContaining({ code: 'HIERARCHY_CYCLE' }),
    ]));
  });
});
