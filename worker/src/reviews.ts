import { all, asNumber, batch, changed, maybeOne, one } from './db';
import { getEntityRow } from './entities';
import {
  apiHeaders,
  booleanQuery,
  conflict,
  decodeCursor,
  encodeCursor,
  HttpError,
  json,
  noContent,
  normalizeLimit,
  notFound,
  mutationIso,
  nowIso,
  optimisticConflict,
  parseJson,
  requireInstant,
  requireInteger,
  requireObject,
  requireUuid,
} from './http';
import { Scale } from './scale';

const DEFAULT_REVIEWER_ID = '00000000-0000-0000-0000-000000000001';
const MAX_PICTURES = 3;
const MAX_PICTURE_BYTES = 100_000_000;
const R2_DELETION_BATCH = 20;

interface R2DeletionRow extends Record<string, unknown> {
  storage_key: string;
}

function pictureTooLarge(): HttpError {
  return new HttpError(413, 'PAYLOAD_TOO_LARGE', `Each picture must be at most ${MAX_PICTURE_BYTES} bytes`, {
    maximumBytes: String(MAX_PICTURE_BYTES),
  });
}

export async function drainR2DeletionOutbox(env: Env, storageKey?: string): Promise<void> {
  let rows: R2DeletionRow[];
  try {
    rows = storageKey
      ? await all<R2DeletionRow>(env.DB.prepare(
        'SELECT storage_key FROM r2_deletion WHERE storage_key = ? LIMIT 1',
      ).bind(storageKey))
      : await all<R2DeletionRow>(env.DB.prepare(
        'SELECT storage_key FROM r2_deletion ORDER BY requested_at, storage_key LIMIT ?',
      ).bind(R2_DELETION_BATCH));
  } catch (error) {
    console.error(JSON.stringify({ event: 'r2_deletion_outbox_read_failed', storageKey, error: String(error) }));
    return;
  }
  for (const row of rows) {
    try {
      await env.DB.prepare(
        'UPDATE r2_deletion SET attempt_count = attempt_count + 1, last_attempt_at = ? WHERE storage_key = ?',
      ).bind(nowIso(), row.storage_key).run();
      await env.PICTURES.delete(row.storage_key);
      await env.DB.prepare('DELETE FROM r2_deletion WHERE storage_key = ?').bind(row.storage_key).run();
    } catch (error) {
      console.error(JSON.stringify({ event: 'r2_deletion_failed', storageKey: row.storage_key, error: String(error) }));
    }
  }
}

async function deleteUncommittedR2Object(env: Env, storageKey: string): Promise<void> {
  try {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO r2_deletion(storage_key, requested_at, attempt_count, last_attempt_at) VALUES (?, ?, 0, NULL)',
    ).bind(storageKey, nowIso()).run();
    await drainR2DeletionOutbox(env, storageKey);
  } catch (error) {
    try {
      await env.PICTURES.delete(storageKey);
    } catch (deleteError) {
      console.error(JSON.stringify({
        event: 'untracked_r2_deletion_failed', storageKey, error: String(error), deleteError: String(deleteError),
      }));
    }
  }
}

export interface ReviewRow extends Record<string, unknown> {
  id: string;
  entity_id: string;
  reviewer_id: string;
  template_version_id: string;
  reviewed_at: string;
  status: 'draft' | 'final' | 'superseded';
  supersedes_review_id: string | null;
  created_at: string;
  updated_at: string;
  lock_version: number;
  hidden_at: string | null;
}

export interface TemplateCriterionRow extends Record<string, unknown> {
  template_version_id: string;
  criterion_id: string;
  name: string;
  description: string | null;
  min_value: string;
  max_value: string;
  step_value: string;
  position: number;
  required: number;
}

interface ScoreRow extends Record<string, unknown> {
  review_id: string;
  criterion_id: string;
  tick_index: number;
  name: string;
  min_value: string;
  max_value: string;
  step_value: string;
  position: number;
}

interface PictureRow extends Record<string, unknown> {
  review_id: string;
  id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  storage_key: string;
  created_at: string;
  position: number;
  reference_count?: number;
}

interface ReviewWrite {
  reviewedAt: string;
  reviewerId: string;
  scores: Array<{ criterionId: string; tickIndex: number }>;
  revision?: number;
  finalize: boolean;
}

export async function getReviewRow(database: D1Database, id: string): Promise<ReviewRow> {
  return one<ReviewRow>(database.prepare('SELECT * FROM review WHERE id = ?').bind(id), 'Review', id);
}

export async function getTemplateCriteria(database: D1Database, templateId: string): Promise<TemplateCriterionRow[]> {
  return all<TemplateCriterionRow>(database.prepare(
    'SELECT * FROM template_criterion WHERE template_version_id = ? ORDER BY position, criterion_id',
  ).bind(templateId));
}

export async function reviewDtos(database: D1Database, rows: ReviewRow[]): Promise<Array<Record<string, unknown>>> {
  if (rows.length === 0) return [];
  if (rows.length > 80) {
    const result: Array<Record<string, unknown>> = [];
    for (let offset = 0; offset < rows.length; offset += 80) {
      result.push(...await reviewDtos(database, rows.slice(offset, offset + 80)));
    }
    return result;
  }
  const placeholders = rows.map(() => '?').join(',');
  const ids = rows.map((row) => row.id);
  const [metadata, scores, pictures] = await Promise.all([
    all<{ review_id: string; display_name: string; version: number } & Record<string, unknown>>(
      database.prepare(
        `SELECT r.id AS review_id, rv.display_name, tv.version
         FROM review r JOIN reviewer rv ON rv.id = r.reviewer_id
         JOIN template_version tv ON tv.id = r.template_version_id
         WHERE r.id IN (${placeholders})`,
      ).bind(...ids),
    ),
    all<ScoreRow>(database.prepare(
      `SELECT s.review_id, s.criterion_id, s.tick_index, tc.name, tc.min_value,
              tc.max_value, tc.step_value, tc.position
       FROM score s JOIN review r ON r.id = s.review_id
       JOIN template_criterion tc
         ON tc.template_version_id = r.template_version_id AND tc.criterion_id = s.criterion_id
       WHERE s.review_id IN (${placeholders})
       ORDER BY s.review_id, tc.position, s.criterion_id`,
    ).bind(...ids)),
    all<PictureRow>(database.prepare(
      `SELECT rp.review_id, rp.position, pa.*
       FROM review_picture rp JOIN picture_asset pa ON pa.id = rp.picture_id
       WHERE rp.review_id IN (${placeholders}) ORDER BY rp.review_id, rp.position`,
    ).bind(...ids)),
  ]);
  const metadataByReview = new Map(metadata.map((row) => [row.review_id, row]));
  const scoresByReview = new Map<string, ScoreRow[]>();
  const picturesByReview = new Map<string, PictureRow[]>();
  for (const score of scores) {
    const list = scoresByReview.get(score.review_id) ?? [];
    list.push(score); scoresByReview.set(score.review_id, list);
  }
  for (const picture of pictures) {
    const list = picturesByReview.get(picture.review_id) ?? [];
    list.push(picture); picturesByReview.set(picture.review_id, list);
  }
  return rows.map((row) => {
    const meta = metadataByReview.get(row.id);
    if (!meta) conflict('Review metadata is incomplete', { reviewId: row.id });
    return {
      id: row.id,
      entityId: row.entity_id,
      reviewerId: row.reviewer_id,
      reviewer: { id: row.reviewer_id, displayName: meta.display_name },
      templateVersionId: row.template_version_id,
      templateVersion: { id: row.template_version_id, version: asNumber(meta.version) },
      reviewedAt: row.reviewed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status: row.status,
      hiddenAt: row.hidden_at,
      supersedesReviewId: row.supersedes_review_id,
      scores: (scoresByReview.get(row.id) ?? []).map((score) => {
        const scale = new Scale(score.min_value, score.max_value, score.step_value);
        const tick = asNumber(score.tick_index);
        return {
          criterionId: score.criterion_id,
          criterionName: score.name,
          tickIndex: tick,
          displayValue: scale.display(tick),
          normalizedValue: scale.normalized(tick),
          minValue: scale.minValue(),
          maxValue: scale.maxValue(),
          stepValue: scale.stepValue(),
        };
      }),
      pictures: (picturesByReview.get(row.id) ?? []).map((picture) => ({
        id: picture.id,
        fileName: picture.file_name,
        contentType: picture.content_type,
        sizeBytes: asNumber(picture.size_bytes),
        url: `reviews/${row.id}/pictures/${picture.id}`,
        createdAt: picture.created_at,
      })),
      revision: asNumber(row.lock_version),
    };
  });
}

export async function reviewDto(database: D1Database, row: ReviewRow): Promise<Record<string, unknown>> {
  return (await reviewDtos(database, [row]))[0]!;
}

function readReviewWrite(value: unknown, revisionRequired = false): ReviewWrite {
  const body = requireObject(value);
  const reviewedAt = requireInstant(body.reviewedAt, 'reviewedAt');
  const reviewerId = body.reviewerId === undefined || body.reviewerId === null
    ? DEFAULT_REVIEWER_ID : requireUuid(body.reviewerId, 'reviewerId');
  if (body.scores !== undefined && !Array.isArray(body.scores)) {
    throw new HttpError(422, 'INVALID_ARGUMENT', 'scores must be an array');
  }
  const scores = (body.scores ?? []).map((raw, index) => {
    const score = requireObject(raw);
    try {
      return {
        criterionId: requireUuid(score.criterionId, 'criterionId'),
        tickIndex: requireInteger(score.tickIndex, 'tickIndex', 0),
      };
    } catch (error) {
      if (error instanceof HttpError) error.details.path = `scores[${index}]`;
      throw error;
    }
  });
  let revision: number | undefined;
  if (body.revision !== undefined) revision = requireInteger(body.revision, 'revision', 0);
  if (revisionRequired && revision === undefined) {
    throw new HttpError(422, 'INVALID_ARGUMENT', 'revision is required when updating a review');
  }
  if (body.finalize !== undefined && typeof body.finalize !== 'boolean') {
    throw new HttpError(422, 'INVALID_ARGUMENT', 'finalize must be a boolean');
  }
  return { reviewedAt, reviewerId, scores, revision, finalize: body.finalize === true };
}

async function requireActiveReviewer(database: D1Database, id: string): Promise<void> {
  const row = await maybeOne<{ archived_at: string | null } & Record<string, unknown>>(
    database.prepare('SELECT archived_at FROM reviewer WHERE id = ?').bind(id),
  );
  if (!row) notFound('Reviewer', id);
  if (row.archived_at) conflict('Archived reviewers cannot write reviews', { reviewerId: id });
}

async function validateScores(
  database: D1Database,
  templateId: string,
  scores: Array<{ criterionId: string; tickIndex: number }>,
  complete: boolean,
): Promise<void> {
  const criteria = await getTemplateCriteria(database, templateId);
  const definitions = new Map(criteria.map((criterion) => [criterion.criterion_id, criterion]));
  const supplied = new Set<string>();
  for (const score of scores) {
    if (supplied.has(score.criterionId)) {
      throw new HttpError(422, 'DUPLICATE_CRITERION', 'A review can only contain one score per criterion', { criterionId: score.criterionId });
    }
    supplied.add(score.criterionId);
    const criterion = definitions.get(score.criterionId);
    if (!criterion) {
      throw new HttpError(422, 'UNKNOWN_CRITERION', 'Score criterion is not defined by the review template', {
        criterionId: score.criterionId, templateVersionId: templateId,
      });
    }
    new Scale(criterion.min_value, criterion.max_value, criterion.step_value).requireTick(score.tickIndex);
  }
  if (complete) {
    const missing = criteria.find((criterion) => asNumber(criterion.required) !== 0 && !supplied.has(criterion.criterion_id));
    if (missing) {
      throw new HttpError(422, 'REQUIRED_SCORE_MISSING', 'A required criterion has no score', {
        criterionId: missing.criterion_id, templateVersionId: templateId,
      });
    }
  }
}

function ensureDraft(review: ReviewRow): void {
  if (review.status !== 'draft') {
    throw new HttpError(409, 'IMMUTABLE_RESOURCE', 'Final or superseded reviews cannot be edited', {
      reviewId: review.id, status: review.status,
    });
  }
}

function parseRequiredRevision(url: URL): number {
  const raw = url.searchParams.get('revision');
  if (raw === null || !/^\d+$/.test(raw)) throw new HttpError(422, 'INVALID_ARGUMENT', 'Missing or invalid query parameter revision');
  const revision = Number(raw);
  if (!Number.isSafeInteger(revision)) throw new HttpError(422, 'INVALID_ARGUMENT', 'Missing or invalid query parameter revision');
  return revision;
}

function conditionalScoreStatements(
  database: D1Database,
  reviewId: string,
  revision: number,
  mutationTimestamp: string,
  scores: Array<{ criterionId: string; tickIndex: number }>,
): D1PreparedStatement[] {
  return [
    database.prepare(
      `DELETE FROM score WHERE review_id = ?
       AND EXISTS (SELECT 1 FROM review WHERE id = ? AND lock_version = ? AND updated_at = ?)`,
    ).bind(reviewId, reviewId, revision, mutationTimestamp),
    ...scores.map((score) => database.prepare(
      `INSERT INTO score(review_id, criterion_id, tick_index)
       SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM review WHERE id = ? AND lock_version = ? AND updated_at = ?)`,
    ).bind(reviewId, score.criterionId, score.tickIndex, reviewId, revision, mutationTimestamp)),
  ];
}

function sanitizeFileName(raw: string | null): string {
  const leaf = (raw ?? '').split(/[\\/]/).at(-1) ?? '';
  const sanitized = Array.from(leaf, (character) => /[\u0000-\u001f\u007f]/.test(character) ? '_' : character)
    .join('').trim();
  return Array.from(sanitized || 'picture').slice(0, 255).join('');
}

function detectPictureType(bytes: Uint8Array): { contentType: string; extension: string } | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: 'image/jpeg', extension: 'jpg' };
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((value, index) => bytes[index] === value)) {
    return { contentType: 'image/png', extension: 'png' };
  }
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) {
    return { contentType: 'image/gif', extension: 'gif' };
  }
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return { contentType: 'image/webp', extension: 'webp' };
  }
  return null;
}

async function listReviewPictures(database: D1Database, reviewId: string): Promise<PictureRow[]> {
  return all<PictureRow>(database.prepare(
    `SELECT rp.review_id, rp.position, pa.*,
       (SELECT COUNT(*) FROM review_picture refs WHERE refs.picture_id = pa.id) AS reference_count
     FROM review_picture rp JOIN picture_asset pa ON pa.id = rp.picture_id
     WHERE rp.review_id = ? ORDER BY rp.position`,
  ).bind(reviewId));
}

async function uploadPicture(request: Request, env: Env, reviewId: string): Promise<Response> {
  const url = new URL(request.url);
  const expected = parseRequiredRevision(url);
  const lengthHeader = request.headers.get('content-length');
  if (lengthHeader === null) {
    await request.body?.cancel().catch(() => undefined);
    throw new HttpError(411, 'LENGTH_REQUIRED', 'Picture uploads require a Content-Length header');
  }
  const length = Number(lengthHeader);
  if (!Number.isSafeInteger(length) || length < 1) {
    await request.body?.cancel().catch(() => undefined);
    throw new HttpError(422, 'INVALID_ARGUMENT', 'Picture content must not be empty');
  }
  if (length > MAX_PICTURE_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    throw pictureTooLarge();
  }
  if (!request.body) throw new HttpError(422, 'INVALID_ARGUMENT', 'Picture content must not be empty');
  const review = await getReviewRow(env.DB, reviewId);
  ensureDraft(review);
  const actual = asNumber(review.lock_version);
  if (actual !== expected) optimisticConflict('Review', reviewId, expected, actual);
  const pictures = await listReviewPictures(env.DB, reviewId);
  if (pictures.length >= MAX_PICTURES) {
    throw new HttpError(409, 'PICTURE_LIMIT_EXCEEDED', `A review can contain at most ${MAX_PICTURES} pictures`, {
      reviewId, maximum: String(MAX_PICTURES),
    });
  }
  const position = [0, 1, 2].find((candidate) => !pictures.some((picture) => asNumber(picture.position) === candidate));
  if (position === undefined) throw new HttpError(409, 'PICTURE_LIMIT_EXCEEDED', 'No picture position is available');

  const pictureId = crypto.randomUUID();
  const storageKey = `review-pictures/${reviewId}/${pictureId}`;
  let stored: R2Object;
  try {
    const uploaded = await env.PICTURES.put(storageKey, request.body);
    if (!uploaded) throw new Error('R2 did not return the stored object');
    stored = uploaded;
  } catch (error) {
    await deleteUncommittedR2Object(env, storageKey);
    console.error(JSON.stringify({ event: 'picture_upload_failed', reviewId, pictureId, error: String(error) }));
    throw new HttpError(400, 'INVALID_ARGUMENT', 'The picture upload could not be read');
  }
  try {
    if (stored.size < 1) throw new HttpError(422, 'INVALID_ARGUMENT', 'Picture content must not be empty');
    if (stored.size > MAX_PICTURE_BYTES) throw pictureTooLarge();
    const headerObject = await env.PICTURES.get(storageKey, { range: { offset: 0, length: 12 } });
    if (!headerObject) throw new HttpError(409, 'CONFLICT', 'Picture content is unavailable');
    const media = detectPictureType(new Uint8Array(await headerObject.arrayBuffer()));
    if (!media) {
      throw new HttpError(415, 'UNSUPPORTED_PICTURE_TYPE', 'Only JPEG, PNG, WebP, and GIF pictures are supported', {
        fileName: sanitizeFileName(url.searchParams.get('fileName')),
      });
    }
    const createdAt = mutationIso();
    const nextRevision = expected + 1;
    const results = await batch(env.DB, [
      env.DB.prepare(
        `UPDATE review SET updated_at = ?, lock_version = lock_version + 1
         WHERE id = ? AND status = 'draft' AND lock_version = ?`,
      ).bind(createdAt, reviewId, expected),
      env.DB.prepare(
        `INSERT INTO picture_asset(id, file_name, content_type, size_bytes, storage_key, created_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM review WHERE id = ? AND status = 'draft' AND lock_version = ? AND updated_at = ?)`,
      ).bind(pictureId, sanitizeFileName(url.searchParams.get('fileName')), media.contentType, stored.size, storageKey, createdAt, reviewId, nextRevision, createdAt),
      env.DB.prepare(
        `INSERT INTO review_picture(review_id, picture_id, position)
         SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM picture_asset WHERE id = ?)`,
      ).bind(reviewId, pictureId, position, pictureId),
    ]);
    if (changed(results[0]!) !== 1) optimisticConflict('Review', reviewId, expected);
  } catch (error) {
    await deleteUncommittedR2Object(env, storageKey);
    throw error;
  }
  return json(await reviewDto(env.DB, await getReviewRow(env.DB, reviewId)), 201);
}

async function getPicture(env: Env, reviewId: string, pictureId: string): Promise<Response> {
  await getReviewRow(env.DB, reviewId);
  const picture = await maybeOne<PictureRow>(env.DB.prepare(
    `SELECT rp.review_id, rp.position, pa.* FROM review_picture rp
     JOIN picture_asset pa ON pa.id = rp.picture_id
     WHERE rp.review_id = ? AND rp.picture_id = ?`,
  ).bind(reviewId, pictureId));
  if (!picture) notFound('Picture', pictureId);
  const object = await env.PICTURES.get(picture.storage_key);
  if (!object) throw new HttpError(409, 'CONFLICT', 'Picture content is unavailable');
  const safeName = picture.file_name.replace(/["\r\n]/g, '_');
  const headers = apiHeaders({
    'Content-Type': picture.content_type,
    'Content-Length': String(picture.size_bytes),
    'Content-Disposition': `inline; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(picture.file_name)}`,
  });
  return new Response(object.body, { headers });
}

async function deletePicture(env: Env, reviewId: string, pictureId: string, expected: number): Promise<Response> {
  const review = await getReviewRow(env.DB, reviewId);
  ensureDraft(review);
  const actual = asNumber(review.lock_version);
  if (actual !== expected) optimisticConflict('Review', reviewId, expected, actual);
  const picture = await maybeOne<PictureRow>(env.DB.prepare(
    `SELECT rp.review_id, rp.position, pa.*,
       (SELECT COUNT(*) FROM review_picture refs WHERE refs.picture_id = pa.id) AS reference_count
     FROM review_picture rp JOIN picture_asset pa ON pa.id = rp.picture_id
     WHERE rp.review_id = ? AND rp.picture_id = ?`,
  ).bind(reviewId, pictureId));
  if (!picture) notFound('Picture', pictureId);
  const nextRevision = expected + 1;
  const changedAt = mutationIso();
  const results = await batch(env.DB, [
    env.DB.prepare(
      `UPDATE review SET updated_at = ?, lock_version = lock_version + 1
       WHERE id = ? AND status = 'draft' AND lock_version = ?`,
    ).bind(changedAt, reviewId, expected),
    env.DB.prepare(
      `DELETE FROM review_picture WHERE review_id = ? AND picture_id = ?
       AND EXISTS (SELECT 1 FROM review WHERE id = ? AND lock_version = ? AND updated_at = ?)`,
    ).bind(reviewId, pictureId, reviewId, nextRevision, changedAt),
    env.DB.prepare(
      `DELETE FROM picture_asset WHERE id = ?
       AND NOT EXISTS (SELECT 1 FROM review_picture WHERE picture_id = ?)`,
    ).bind(pictureId, pictureId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO r2_deletion(storage_key, requested_at, attempt_count, last_attempt_at)
       SELECT ?, ?, 0, NULL WHERE NOT EXISTS (SELECT 1 FROM picture_asset WHERE id = ?)`,
    ).bind(picture.storage_key, nowIso(), pictureId),
  ]);
  if (changed(results[0]!) !== 1) optimisticConflict('Review', reviewId, expected);
  if (changed(results[2]!) === 1) await drainR2DeletionOutbox(env, picture.storage_key);
  return json(await reviewDto(env.DB, await getReviewRow(env.DB, reviewId)));
}

export async function handleReviewRoutes(
  request: Request,
  env: Env,
  path: string[],
  method: string,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (path[0] === 'entities' && path.length === 3 && path[2] === 'reviews') {
    const entityId = requireUuid(path[1], 'entityId');
    if (method === 'GET') {
      await getEntityRow(env.DB, entityId);
      const offset = decodeCursor(url.searchParams.get('cursor'));
      const limit = normalizeLimit(url.searchParams.get('limit'));
      const includeSuperseded = booleanQuery(url, 'includeSuperseded');
      const includeHidden = booleanQuery(url, 'includeHidden');
      const rows = await all<ReviewRow>(env.DB.prepare(
        `SELECT * FROM review WHERE entity_id = ?
         AND (? = 1 OR status <> 'superseded') AND (? = 1 OR hidden_at IS NULL)
         ORDER BY reviewed_at DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`,
      ).bind(entityId, includeSuperseded ? 1 : 0, includeHidden ? 1 : 0, limit + 1, offset));
      return json({
        items: await reviewDtos(env.DB, rows.slice(0, limit)),
        nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null,
      });
    }
    if (method === 'POST') {
      const entity = await getEntityRow(env.DB, entityId);
      if (entity.archived_at) conflict('Archived entities cannot receive new reviews', { entityId });
      const category = await one<{ active_template_version_id: string | null } & Record<string, unknown>>(
        env.DB.prepare('SELECT active_template_version_id FROM category WHERE id = ?').bind(entity.category_id),
        'Category', entity.category_id,
      );
      if (!category.active_template_version_id) conflict('The entity category has no active template', { categoryId: entity.category_id });
      const template = await one<{ status: string } & Record<string, unknown>>(
        env.DB.prepare('SELECT status FROM template_version WHERE id = ?').bind(category.active_template_version_id),
        'Template version', category.active_template_version_id,
      );
      if (template.status !== 'published') conflict('The active template is not published', { templateVersionId: category.active_template_version_id });
      const write = readReviewWrite(await parseJson<unknown>(request));
      await requireActiveReviewer(env.DB, write.reviewerId);
      await validateScores(env.DB, category.active_template_version_id, write.scores, write.finalize);
      const id = crypto.randomUUID();
      const now = nowIso();
      const results = await batch(env.DB, [
        env.DB.prepare(
          `INSERT INTO review(id, entity_id, reviewer_id, template_version_id, reviewed_at, status,
           supersedes_review_id, created_at, updated_at, lock_version, hidden_at)
           SELECT ?, e.id, rv.id, tv.id, ?, ?, NULL, ?, ?, 0, NULL
           FROM entity e
           JOIN category c ON c.id = e.category_id
           JOIN template_version tv ON tv.id = c.active_template_version_id
           JOIN reviewer rv ON rv.id = ?
           WHERE e.id = ? AND e.archived_at IS NULL AND rv.archived_at IS NULL
             AND tv.id = ? AND tv.status = 'published' AND tv.category_id = e.category_id`,
        ).bind(
          id, write.reviewedAt, write.finalize ? 'final' : 'draft', now, now,
          write.reviewerId, entityId, category.active_template_version_id,
        ),
        ...write.scores.map((score) => env.DB.prepare(
          `INSERT INTO score(review_id, criterion_id, tick_index)
           SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM review WHERE id = ?)`,
        ).bind(id, score.criterionId, score.tickIndex, id)),
      ]);
      if (changed(results[0]!) !== 1) {
        const latestEntity = await getEntityRow(env.DB, entityId);
        if (latestEntity.archived_at) conflict('Archived entities cannot receive new reviews', { entityId });
        await requireActiveReviewer(env.DB, write.reviewerId);
        conflict('The review target changed while the review was being saved', { retryable: 'true', entityId });
      }
      return json(await reviewDto(env.DB, await getReviewRow(env.DB, id)), 201);
    }
    return null;
  }

  if (path[0] !== 'reviews' || path.length < 2) return null;
  const reviewId = requireUuid(path[1], 'reviewId');

  if (path.length === 2 && method === 'GET') return json(await reviewDto(env.DB, await getReviewRow(env.DB, reviewId)));

  if (path.length === 2 && method === 'PATCH') {
    const current = await getReviewRow(env.DB, reviewId);
    ensureDraft(current);
    const write = readReviewWrite(await parseJson<unknown>(request), true);
    const expected = write.revision!;
    const actual = asNumber(current.lock_version);
    if (actual !== expected) optimisticConflict('Review', reviewId, expected, actual);
    await requireActiveReviewer(env.DB, write.reviewerId);
    await validateScores(env.DB, current.template_version_id, write.scores, write.finalize);
    const nextRevision = expected + 1;
    const changedAt = mutationIso();
    const results = await batch(env.DB, [
      env.DB.prepare(
        `UPDATE review SET reviewer_id = ?, reviewed_at = ?, status = ?, updated_at = ?, lock_version = lock_version + 1
         WHERE id = ? AND status = 'draft' AND lock_version = ?`,
      ).bind(write.reviewerId, write.reviewedAt, write.finalize ? 'final' : 'draft', changedAt, reviewId, expected),
      ...conditionalScoreStatements(env.DB, reviewId, nextRevision, changedAt, write.scores),
    ]);
    if (changed(results[0]!) !== 1) optimisticConflict('Review', reviewId, expected);
    return json(await reviewDto(env.DB, await getReviewRow(env.DB, reviewId)));
  }

  if (path.length === 2 && method === 'DELETE') {
    const expected = parseRequiredRevision(url);
    const current = await getReviewRow(env.DB, reviewId);
    ensureDraft(current);
    const actual = asNumber(current.lock_version);
    if (actual !== expected) optimisticConflict('Review', reviewId, expected, actual);
    const pictures = await listReviewPictures(env.DB, reviewId);
    const statements: D1PreparedStatement[] = [
      env.DB.prepare("DELETE FROM review WHERE id = ? AND status = 'draft' AND lock_version = ?").bind(reviewId, expected),
    ];
    for (const picture of pictures) {
      statements.push(
        env.DB.prepare(
          'DELETE FROM picture_asset WHERE id = ? AND NOT EXISTS (SELECT 1 FROM review_picture WHERE picture_id = ?)',
        ).bind(picture.id, picture.id),
        env.DB.prepare(
          `INSERT OR IGNORE INTO r2_deletion(storage_key, requested_at, attempt_count, last_attempt_at)
           SELECT ?, ?, 0, NULL WHERE NOT EXISTS (SELECT 1 FROM picture_asset WHERE id = ?)`,
        ).bind(picture.storage_key, nowIso(), picture.id),
      );
    }
    const results = await batch(env.DB, statements);
    if (changed(results[0]!) !== 1) optimisticConflict('Review', reviewId, expected);
    const keysToDelete = pictures
      .filter((_picture, index) => changed(results[1 + index * 2]!) === 1)
      .map((picture) => picture.storage_key);
    await Promise.all(keysToDelete.map((key) => drainR2DeletionOutbox(env, key)));
    return noContent();
  }

  if (path.length === 3 && path[2] === 'finalize' && method === 'POST') {
    const current = await getReviewRow(env.DB, reviewId);
    ensureDraft(current);
    const body = requireObject(await parseJson<unknown>(request));
    const expected = requireInteger(body.revision, 'revision', 0);
    const actual = asNumber(current.lock_version);
    if (actual !== expected) optimisticConflict('Review', reviewId, expected, actual);
    let replacement: Array<{ criterionId: string; tickIndex: number }> | null = null;
    if (body.scores !== undefined && body.scores !== null) {
      if (!Array.isArray(body.scores)) throw new HttpError(422, 'INVALID_ARGUMENT', 'scores must be an array');
      replacement = body.scores.map((raw) => {
        const score = requireObject(raw);
        return { criterionId: requireUuid(score.criterionId, 'criterionId'), tickIndex: requireInteger(score.tickIndex, 'tickIndex', 0) };
      });
    }
    const scores: Array<{ criterionId: string; tickIndex: number }> = replacement !== null
      ? replacement
      : await all<{ criterion_id: string; tick_index: number } & Record<string, unknown>>(
        env.DB.prepare('SELECT criterion_id, tick_index FROM score WHERE review_id = ?').bind(reviewId),
      ).then((items) => items.map((item) => ({ criterionId: item.criterion_id, tickIndex: asNumber(item.tick_index) })));
    await validateScores(env.DB, current.template_version_id, scores, true);
    const nextRevision = expected + 1;
    const changedAt = mutationIso();
    const results = await batch(env.DB, [
      env.DB.prepare(
        `UPDATE review SET status = 'final', updated_at = ?, lock_version = lock_version + 1
         WHERE id = ? AND status = 'draft' AND lock_version = ?`,
      ).bind(changedAt, reviewId, expected),
      ...(replacement ? conditionalScoreStatements(env.DB, reviewId, nextRevision, changedAt, replacement) : []),
    ]);
    if (changed(results[0]!) !== 1) optimisticConflict('Review', reviewId, expected);
    return json(await reviewDto(env.DB, await getReviewRow(env.DB, reviewId)));
  }

  if (path.length === 3 && path[2] === 'revisions' && method === 'POST') {
    const original = await getReviewRow(env.DB, reviewId);
    if (original.status !== 'final') throw new HttpError(409, 'INVALID_STATE_TRANSITION', 'Only a final review can be revised');
    const write = readReviewWrite(await parseJson<unknown>(request), true);
    const expected = write.revision!;
    const actual = asNumber(original.lock_version);
    if (actual !== expected) optimisticConflict('Review', reviewId, expected, actual);
    await requireActiveReviewer(env.DB, write.reviewerId);
    await validateScores(env.DB, original.template_version_id, write.scores, true);
    const replacementId = crypto.randomUUID();
    const now = mutationIso();
    const nextOriginalRevision = expected + 1;
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        `UPDATE review SET status = 'superseded', updated_at = ?, lock_version = lock_version + 1
         WHERE id = ? AND status = 'final' AND lock_version = ?`,
      ).bind(now, reviewId, expected),
      env.DB.prepare(
        `INSERT INTO review(id, entity_id, reviewer_id, template_version_id, reviewed_at, status,
         supersedes_review_id, created_at, updated_at, lock_version, hidden_at)
         SELECT ?, ?, ?, ?, ?, 'final', ?, ?, ?, 0, NULL
         WHERE EXISTS (SELECT 1 FROM review WHERE id = ? AND status = 'superseded' AND lock_version = ? AND updated_at = ?)`,
      ).bind(replacementId, original.entity_id, write.reviewerId, original.template_version_id, write.reviewedAt,
        reviewId, now, now, reviewId, nextOriginalRevision, now),
      ...write.scores.map((score) => env.DB.prepare(
        `INSERT INTO score(review_id, criterion_id, tick_index)
         SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM review WHERE id = ?)`,
      ).bind(replacementId, score.criterionId, score.tickIndex, replacementId)),
      env.DB.prepare(
        `INSERT INTO review_picture(review_id, picture_id, position)
         SELECT ?, picture_id, position FROM review_picture
         WHERE review_id = ? AND EXISTS (SELECT 1 FROM review WHERE id = ?)`,
      ).bind(replacementId, reviewId, replacementId),
    ];
    const results = await batch(env.DB, statements);
    if (changed(results[0]!) !== 1) optimisticConflict('Review', reviewId, expected);
    return json(await reviewDto(env.DB, await getReviewRow(env.DB, replacementId)), 201);
  }

  if (path.length === 3 && path[2] === 'visibility' && method === 'PATCH') {
    const current = await getReviewRow(env.DB, reviewId);
    if (current.status === 'draft') {
      throw new HttpError(409, 'INVALID_STATE_TRANSITION', 'Draft reviews cannot be hidden; delete the draft instead', { reviewId });
    }
    const body = requireObject(await parseJson<unknown>(request));
    if (typeof body.hidden !== 'boolean') throw new HttpError(422, 'INVALID_ARGUMENT', 'hidden must be a boolean');
    const expected = requireInteger(body.revision, 'revision', 0);
    const actual = asNumber(current.lock_version);
    if (actual !== expected) optimisticConflict('Review', reviewId, expected, actual);
    if (body.hidden === Boolean(current.hidden_at)) {
      throw new HttpError(409, 'INVALID_STATE_TRANSITION', body.hidden ? 'Review is already hidden' : 'Review is already visible', { reviewId });
    }
    const result = await env.DB.prepare(
      `UPDATE review SET hidden_at = ?, updated_at = ?, lock_version = lock_version + 1
       WHERE id = ? AND status IN ('final', 'superseded') AND lock_version = ?`,
    ).bind(body.hidden ? nowIso() : null, nowIso(), reviewId, expected).run();
    if (changed(result) !== 1) optimisticConflict('Review', reviewId, expected);
    return json(await reviewDto(env.DB, await getReviewRow(env.DB, reviewId)));
  }

  if (path.length === 3 && path[2] === 'pictures' && method === 'POST') return uploadPicture(request, env, reviewId);

  if (path.length === 4 && path[2] === 'pictures') {
    const pictureId = requireUuid(path[3], 'pictureId');
    if (method === 'GET') return getPicture(env, reviewId, pictureId);
    if (method === 'DELETE') return deletePicture(env, reviewId, pictureId, parseRequiredRevision(url));
  }

  return null;
}
