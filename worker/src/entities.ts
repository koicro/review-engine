import { all, asNumber, changed, one, run } from './db';
import {
  booleanQuery,
  conflict,
  decodeCursor,
  encodeCursor,
  HttpError,
  json,
  noContent,
  normalizeLimit,
  nowIso,
  optimisticConflict,
  optionalText,
  parseJson,
  requireNonBlank,
  requireObject,
  requireUuid,
} from './http';

export interface EntityRow extends Record<string, unknown> {
  id: string;
  category_id: string;
  name: string;
  description: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  lock_version: number;
  category_name?: string;
  review_count?: number;
  latest_reviewed_at?: string | null;
}

interface CategoryRow extends Record<string, unknown> {
  id: string;
  archived_at: string | null;
}

export async function getEntityRow(database: D1Database, id: string): Promise<EntityRow> {
  return one<EntityRow>(database.prepare(
    `SELECT e.*, c.name AS category_name,
       (SELECT COUNT(*) FROM review r WHERE r.entity_id = e.id) AS review_count,
       (SELECT MAX(r.reviewed_at) FROM review r
        WHERE r.entity_id = e.id AND r.status = 'final' AND r.hidden_at IS NULL) AS latest_reviewed_at
     FROM entity e JOIN category c ON c.id = e.category_id WHERE e.id = ?`,
  ).bind(id), 'Entity', id);
}

export function entityDto(row: EntityRow): Record<string, unknown> {
  return {
    id: row.id,
    categoryId: row.category_id,
    category: { id: row.category_id, name: String(row.category_name ?? '') },
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    latestReviewedAt: row.latest_reviewed_at ?? null,
    reviewCount: asNumber(row.review_count ?? 0),
    revision: asNumber(row.lock_version),
  };
}

async function requireCategory(database: D1Database, id: string): Promise<CategoryRow> {
  return one<CategoryRow>(database.prepare('SELECT id, archived_at FROM category WHERE id = ?').bind(id), 'Category', id);
}

export async function handleEntityRoutes(
  request: Request,
  env: Env,
  path: string[],
  method: string,
): Promise<Response | null> {
  if (path[0] !== 'entities') return null;
  const url = new URL(request.url);

  if (path.length === 1 && method === 'GET') {
    const offset = decodeCursor(url.searchParams.get('cursor'));
    const limit = normalizeLimit(url.searchParams.get('limit'));
    const includeArchived = booleanQuery(url, 'includeArchived');
    const categoryIdRaw = url.searchParams.get('categoryId');
    const categoryId = categoryIdRaw ? requireUuid(categoryIdRaw, 'categoryId') : null;
    const query = url.searchParams.get('query')?.trim().toLowerCase() || null;
    const clauses = [includeArchived ? '1 = 1' : 'e.archived_at IS NULL'];
    const bindings: unknown[] = [];
    if (categoryId) { clauses.push('e.category_id = ?'); bindings.push(categoryId); }
    if (query) { clauses.push("lower(e.name) LIKE '%' || ? || '%'"); bindings.push(query); }
    bindings.push(limit + 1, offset);
    const rows = await all<EntityRow>(env.DB.prepare(
      `SELECT e.*, c.name AS category_name,
         (SELECT COUNT(*) FROM review r WHERE r.entity_id = e.id) AS review_count,
         (SELECT MAX(r.reviewed_at) FROM review r
          WHERE r.entity_id = e.id AND r.status = 'final' AND r.hidden_at IS NULL) AS latest_reviewed_at
       FROM entity e JOIN category c ON c.id = e.category_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY lower(e.name), e.id LIMIT ? OFFSET ?`,
    ).bind(...bindings));
    return json({
      items: rows.slice(0, limit).map(entityDto),
      nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null,
    });
  }

  if (path.length === 1 && method === 'POST') {
    const body = requireObject(await parseJson<unknown>(request));
    const categoryId = requireUuid(body.categoryId, 'categoryId');
    const category = await requireCategory(env.DB, categoryId);
    if (category.archived_at) conflict('Archived categories cannot receive new entities', { categoryId });
    const id = crypto.randomUUID();
    const now = nowIso();
    await run(env.DB.prepare(
      `INSERT INTO entity(id, category_id, name, description, archived_at, created_at, updated_at, lock_version)
       VALUES (?, ?, ?, ?, NULL, ?, ?, 0)`,
    ).bind(id, categoryId, requireNonBlank(body.name, 'name'), optionalText(body.description, 'description'), now, now));
    return json(entityDto(await getEntityRow(env.DB, id)), 201);
  }

  if (path.length < 2) return null;
  const id = requireUuid(path[1], 'entityId');

  if (path.length === 2 && method === 'GET') {
    return json(entityDto(await getEntityRow(env.DB, id)));
  }

  if (path.length === 2 && method === 'PATCH') {
    const current = await getEntityRow(env.DB, id);
    const body = requireObject(await parseJson<unknown>(request));
    const expected = body.revision === undefined
      ? asNumber(current.lock_version)
      : (typeof body.revision === 'number' && Number.isSafeInteger(body.revision) ? body.revision : NaN);
    if (!Number.isSafeInteger(expected) || expected < 0) {
      throw new HttpError(422, 'INVALID_ARGUMENT', 'revision must be an integer');
    }
    if (asNumber(current.lock_version) !== expected) optimisticConflict('Entity', id, expected, asNumber(current.lock_version));
    const categoryId = body.categoryId === undefined ? current.category_id : requireUuid(body.categoryId, 'categoryId');
    const categoryChanged = categoryId !== current.category_id;
    if (categoryChanged) {
      const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM review WHERE entity_id = ?').bind(id).first<{ count: number }>();
      if (asNumber(count?.count ?? 0) > 0) conflict('An entity with review history cannot change category', { entityId: id });
      const category = await requireCategory(env.DB, categoryId);
      if (category.archived_at) conflict('An entity cannot move to an archived category', { categoryId });
    }
    const name = body.name === undefined ? current.name : requireNonBlank(body.name, 'name');
    const description = Object.hasOwn(body, 'description') ? optionalText(body.description, 'description') : current.description;
    let archivedAt = current.archived_at;
    if (body.archived !== undefined) {
      if (typeof body.archived !== 'boolean') throw new HttpError(422, 'INVALID_ARGUMENT', 'archived must be a boolean');
      archivedAt = body.archived ? current.archived_at ?? nowIso() : null;
    }
    const result = await run(env.DB.prepare(
      `UPDATE entity SET category_id = ?, name = ?, description = ?, archived_at = ?, updated_at = ?, lock_version = lock_version + 1
       WHERE id = ? AND lock_version = ?
         AND (? = 0 OR NOT EXISTS (SELECT 1 FROM review WHERE entity_id = ?))
         AND (? = 0 OR EXISTS (SELECT 1 FROM category WHERE id = ? AND archived_at IS NULL))`,
    ).bind(
      categoryId, name, description, archivedAt, nowIso(), id, expected,
      categoryChanged ? 1 : 0, id, categoryChanged ? 1 : 0, categoryId,
    ));
    if (changed(result) !== 1) {
      const latest = await getEntityRow(env.DB, id);
      if (asNumber(latest.lock_version) !== expected) optimisticConflict('Entity', id, expected, asNumber(latest.lock_version));
      if (categoryChanged) {
        const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM review WHERE entity_id = ?').bind(id).first<number>('count');
        if (asNumber(count ?? 0) > 0) conflict('An entity with review history cannot change category', { entityId: id });
        const category = await requireCategory(env.DB, categoryId);
        if (category.archived_at) conflict('An entity cannot move to an archived category', { categoryId });
      }
      conflict('The write conflicts with existing data', { retryable: 'true' });
    }
    return json(entityDto(await getEntityRow(env.DB, id)));
  }

  if (path.length === 2 && method === 'DELETE') {
    await getEntityRow(env.DB, id);
    try {
      const result = await env.DB.prepare('DELETE FROM entity WHERE id = ?').bind(id).run();
      if (changed(result) !== 1) throw new HttpError(404, 'NOT_FOUND', 'Entity was not found');
    } catch (error) {
      if (error instanceof HttpError) throw error;
      conflict('The entity is still referenced by other data', { entityId: id });
    }
    return noContent();
  }

  return null;
}
