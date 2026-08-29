import { all, asBoolean, asNumber, changed, one, run } from './db';
import { getEntityRow } from './entities';
import {
  conflict,
  decodeCursor,
  encodeCursor,
  HttpError,
  json,
  noContent,
  normalizeLimit,
  notFound,
  nowIso,
  parseJson,
  requireInteger,
  requireNonBlank,
  requireObject,
  requireUuid,
} from './http';

interface RelationTypeRow extends Record<string, unknown> {
  id: string;
  key: string;
  forward_label: string;
  inverse_label: string;
  hierarchical: number;
  created_at: string;
}

interface RelationRow extends Record<string, unknown> {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type_id: string;
  created_at: string;
  source_category_id?: string;
  source_name?: string;
  target_category_id?: string;
  target_name?: string;
  type_key?: string;
  forward_label?: string;
  inverse_label?: string;
  hierarchical?: number;
  type_created_at?: string;
}

function typeDto(row: RelationTypeRow): Record<string, unknown> {
  return {
    id: row.id,
    key: row.key,
    forwardLabel: row.forward_label,
    inverseLabel: row.inverse_label,
    hierarchical: asBoolean(row.hierarchical),
    createdAt: row.created_at,
  };
}

function relationDto(row: RelationRow): Record<string, unknown> {
  const relationType = {
    id: row.relation_type_id,
    key: row.type_key,
    forwardLabel: row.forward_label,
    inverseLabel: row.inverse_label,
    hierarchical: asBoolean(row.hierarchical ?? 0),
    createdAt: row.type_created_at,
  };
  return {
    id: row.id,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    relationTypeId: row.relation_type_id,
    sourceEntity: row.source_name === undefined ? undefined : {
      id: row.source_entity_id, categoryId: row.source_category_id, name: row.source_name,
    },
    targetEntity: row.target_name === undefined ? undefined : {
      id: row.target_entity_id, categoryId: row.target_category_id, name: row.target_name,
    },
    relationType,
    createdAt: row.created_at,
  };
}

async function getRelationType(database: D1Database, id: string): Promise<RelationTypeRow> {
  return one<RelationTypeRow>(database.prepare('SELECT * FROM relation_type WHERE id = ?').bind(id), 'Relation type', id);
}

async function getRelation(database: D1Database, id: string): Promise<RelationRow> {
  return one<RelationRow>(database.prepare(
    `SELECT er.*,
       source.category_id AS source_category_id, source.name AS source_name,
       target.category_id AS target_category_id, target.name AS target_name,
       rt.key AS type_key, rt.forward_label, rt.inverse_label, rt.hierarchical,
       rt.created_at AS type_created_at
     FROM entity_relation er
     JOIN entity source ON source.id = er.source_entity_id
     JOIN entity target ON target.id = er.target_entity_id
     JOIN relation_type rt ON rt.id = er.relation_type_id
     WHERE er.id = ?`,
  ).bind(id), 'Relation', id);
}

function joinedRelationType(row: RelationRow): RelationTypeRow {
  return {
    id: row.relation_type_id,
    key: String(row.type_key),
    forward_label: String(row.forward_label),
    inverse_label: String(row.inverse_label),
    hierarchical: asNumber(row.hierarchical ?? 0),
    created_at: String(row.type_created_at),
  };
}

async function relatedEntities(
  env: Env,
  entityId: string,
  relationTypeId: string | null,
  direction: 'outgoing' | 'incoming' | 'both',
  maxDepth: number,
): Promise<Array<Record<string, unknown>>> {
  await getEntityRow(env.DB, entityId);
  if (relationTypeId) await getRelationType(env.DB, relationTypeId);
  if (maxDepth < 1 || maxDepth > 5) throw new HttpError(422, 'INVALID_ARGUMENT', 'maxDepth must be between 1 and 5');
  let frontier: Array<{ id: string; depth: number; path: string[] }> = [{ id: entityId, depth: 0, path: [entityId] }];
  const visited = new Set([entityId]);
  const found: Array<Record<string, unknown>> = [];
  while (frontier.length > 0 && found.length < 500) {
    const expandable = frontier.filter((node) => node.depth < maxDepth);
    if (expandable.length === 0) break;
    const nextFrontier: typeof frontier = [];
    for (let offset = 0; offset < expandable.length && found.length < 500; offset += 40) {
      const nodes = expandable.slice(offset, offset + 40);
      const nodeIds = nodes.map((node) => node.id);
      const placeholders = nodeIds.map(() => '?').join(',');
      const bindings: unknown[] = [...nodeIds];
      let adjacency: string;
      if (direction === 'outgoing') {
        adjacency = `er.source_entity_id IN (${placeholders})`;
      } else if (direction === 'incoming') {
        adjacency = `er.target_entity_id IN (${placeholders})`;
      } else {
        adjacency = `(er.source_entity_id IN (${placeholders}) OR er.target_entity_id IN (${placeholders}))`;
        bindings.push(...nodeIds);
      }
      const typeClause = relationTypeId ? ' AND er.relation_type_id = ?' : '';
      if (relationTypeId) bindings.push(relationTypeId);
      const relations = await all<RelationRow>(env.DB.prepare(
        `SELECT er.*,
           source.category_id AS source_category_id, source.name AS source_name,
           target.category_id AS target_category_id, target.name AS target_name,
           rt.key AS type_key, rt.forward_label, rt.inverse_label, rt.hierarchical,
           rt.created_at AS type_created_at
         FROM entity_relation er
         JOIN entity source ON source.id = er.source_entity_id
         JOIN entity target ON target.id = er.target_entity_id
         JOIN relation_type rt ON rt.id = er.relation_type_id
         WHERE ${adjacency}${typeClause}
         ORDER BY er.created_at, er.id LIMIT 2000`,
      ).bind(...bindings));
      const relationsByNode = new Map(nodes.map((node) => [node.id, [] as RelationRow[]]));
      for (const relation of relations) {
        if (direction !== 'incoming') relationsByNode.get(relation.source_entity_id)?.push(relation);
        if (direction !== 'outgoing' && relation.target_entity_id !== relation.source_entity_id) {
          relationsByNode.get(relation.target_entity_id)?.push(relation);
        }
      }
      for (const node of nodes) {
        for (const relation of relationsByNode.get(node.id) ?? []) {
          if (found.length >= 500) break;
          const edgeDirection = relation.source_entity_id === node.id ? 'outgoing' : 'incoming';
          const nextId = edgeDirection === 'outgoing' ? relation.target_entity_id : relation.source_entity_id;
          if (visited.has(nextId)) continue;
          visited.add(nextId);
          const path = [...node.path, nextId];
          const nextEntity = edgeDirection === 'outgoing'
            ? { id: nextId, categoryId: relation.target_category_id, name: relation.target_name }
            : { id: nextId, categoryId: relation.source_category_id, name: relation.source_name };
          const type = joinedRelationType(relation);
          found.push({
            entity: nextEntity,
            relation: relationDto(relation),
            relationType: typeDto(type),
            direction: edgeDirection,
            depth: node.depth + 1,
            path,
          });
          nextFrontier.push({ id: nextId, depth: node.depth + 1, path });
        }
      }
    }
    frontier = nextFrontier;
  }
  return found;
}

export async function handleRelationRoutes(
  request: Request,
  env: Env,
  path: string[],
  method: string,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (path[0] === 'relation-types' && path.length === 1) {
    if (method === 'GET') {
      const offset = decodeCursor(url.searchParams.get('cursor'));
      const limit = normalizeLimit(url.searchParams.get('limit'));
      const rows = await all<RelationTypeRow>(env.DB.prepare(
        'SELECT * FROM relation_type ORDER BY lower(key), id LIMIT ? OFFSET ?',
      ).bind(limit + 1, offset));
      return json({
        items: rows.slice(0, limit).map(typeDto),
        nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null,
      });
    }
    if (method === 'POST') {
      const body = requireObject(await parseJson<unknown>(request));
      const key = requireNonBlank(body.key, 'key').toLowerCase();
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(key)) {
        throw new HttpError(422, 'INVALID_ARGUMENT', 'Relation type key must use lowercase letters, numbers, underscores, or hyphens');
      }
      if (body.hierarchical !== undefined && typeof body.hierarchical !== 'boolean') {
        throw new HttpError(422, 'INVALID_ARGUMENT', 'hierarchical must be a boolean');
      }
      const id = crypto.randomUUID();
      await run(env.DB.prepare(
        `INSERT INTO relation_type(id, key, forward_label, inverse_label, hierarchical, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(id, key, requireNonBlank(body.forwardLabel, 'forwardLabel'), requireNonBlank(body.inverseLabel, 'inverseLabel'),
        body.hierarchical === true ? 1 : 0, nowIso()));
      return json(typeDto(await getRelationType(env.DB, id)), 201);
    }
    return null;
  }

  if (path[0] === 'relations' && path.length === 1) {
    if (method === 'GET') {
      const offset = decodeCursor(url.searchParams.get('cursor'));
      const limit = normalizeLimit(url.searchParams.get('limit'));
      const entityRaw = url.searchParams.get('entityId');
      const typeRaw = url.searchParams.get('relationTypeId');
      const entityId = entityRaw ? requireUuid(entityRaw, 'entityId') : null;
      const typeId = typeRaw ? requireUuid(typeRaw, 'relationTypeId') : null;
      if (entityId) await getEntityRow(env.DB, entityId);
      if (typeId) await getRelationType(env.DB, typeId);
      const rows = await all<RelationRow>(env.DB.prepare(
        `SELECT er.*,
           source.category_id AS source_category_id, source.name AS source_name,
           target.category_id AS target_category_id, target.name AS target_name,
           rt.key AS type_key, rt.forward_label, rt.inverse_label, rt.hierarchical,
           rt.created_at AS type_created_at
         FROM entity_relation er
         JOIN entity source ON source.id = er.source_entity_id
         JOIN entity target ON target.id = er.target_entity_id
         JOIN relation_type rt ON rt.id = er.relation_type_id
         WHERE (? IS NULL OR er.source_entity_id = ? OR er.target_entity_id = ?)
           AND (? IS NULL OR er.relation_type_id = ?)
         ORDER BY er.created_at DESC, er.id DESC LIMIT ? OFFSET ?`,
      ).bind(entityId, entityId, entityId, typeId, typeId, limit + 1, offset));
      return json({
        items: rows.slice(0, limit).map(relationDto),
        nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null,
      });
    }
    if (method === 'POST') {
      const body = requireObject(await parseJson<unknown>(request));
      const sourceId = requireUuid(body.sourceEntityId, 'sourceEntityId');
      const targetId = requireUuid(body.targetEntityId, 'targetEntityId');
      const typeId = requireUuid(body.relationTypeId, 'relationTypeId');
      const [source, target, type] = await Promise.all([
        getEntityRow(env.DB, sourceId), getEntityRow(env.DB, targetId), getRelationType(env.DB, typeId),
      ]);
      if (source.archived_at || target.archived_at) conflict('Archived entities cannot receive new relations');
      const id = crypto.randomUUID();
      if (asBoolean(type.hierarchical)) {
        const result = await env.DB.prepare(
          `WITH RECURSIVE reachable(id) AS (
             SELECT target_entity_id FROM entity_relation
             WHERE source_entity_id = ? AND relation_type_id = ?
             UNION
             SELECT edge.target_entity_id FROM entity_relation edge
             JOIN reachable ON edge.source_entity_id = reachable.id
             WHERE edge.relation_type_id = ?
           )
           INSERT INTO entity_relation(id, source_entity_id, target_entity_id, relation_type_id, created_at)
           SELECT ?, ?, ?, ?, ?
           WHERE ? <> ? AND NOT EXISTS (SELECT 1 FROM reachable WHERE id = ?)
             AND EXISTS (
               SELECT 1 FROM entity active_source JOIN entity active_target
               WHERE active_source.id = ? AND active_source.archived_at IS NULL
                 AND active_target.id = ? AND active_target.archived_at IS NULL
             )`,
        ).bind(
          targetId,
          typeId,
          typeId,
          id,
          sourceId,
          targetId,
          typeId,
          nowIso(),
          sourceId,
          targetId,
          sourceId,
          sourceId,
          targetId,
        ).run();
        if (changed(result) !== 1) {
          const [latestSource, latestTarget] = await Promise.all([
            getEntityRow(env.DB, sourceId), getEntityRow(env.DB, targetId),
          ]);
          if (latestSource.archived_at || latestTarget.archived_at) {
            conflict('Archived entities cannot receive new relations');
          }
          throw new HttpError(409, 'HIERARCHY_CYCLE', 'The relation would create a hierarchy cycle', {
            relationTypeId: typeId,
          });
        }
      } else {
        const result = await run(env.DB.prepare(
          `INSERT INTO entity_relation(id, source_entity_id, target_entity_id, relation_type_id, created_at)
           SELECT ?, ?, ?, ?, ? WHERE EXISTS (
             SELECT 1 FROM entity active_source JOIN entity active_target
             WHERE active_source.id = ? AND active_source.archived_at IS NULL
               AND active_target.id = ? AND active_target.archived_at IS NULL
           )`,
        ).bind(id, sourceId, targetId, typeId, nowIso(), sourceId, targetId));
        if (changed(result) !== 1) {
          const [latestSource, latestTarget] = await Promise.all([
            getEntityRow(env.DB, sourceId), getEntityRow(env.DB, targetId),
          ]);
          if (latestSource.archived_at || latestTarget.archived_at) {
            conflict('Archived entities cannot receive new relations');
          }
          conflict('The relation target changed while the relation was being saved', { retryable: 'true' });
        }
      }
      return json(relationDto(await getRelation(env.DB, id)), 201);
    }
    return null;
  }

  if (path[0] === 'relations' && path.length === 2 && method === 'DELETE') {
    const id = requireUuid(path[1], 'relationId');
    const result = await env.DB.prepare('DELETE FROM entity_relation WHERE id = ?').bind(id).run();
    if (changed(result) !== 1) notFound('Relation', id);
    return noContent();
  }

  if (path[0] === 'entities' && path.length === 3 && path[2] === 'related' && method === 'GET') {
    const entityId = requireUuid(path[1], 'entityId');
    const typeRaw = url.searchParams.get('relationTypeId');
    const typeId = typeRaw ? requireUuid(typeRaw, 'relationTypeId') : null;
    const rawDirection = (url.searchParams.get('direction') ?? 'both').toLowerCase();
    if (!['outgoing', 'incoming', 'both'].includes(rawDirection)) {
      throw new HttpError(422, 'INVALID_ARGUMENT', `Unsupported value '${rawDirection}'`);
    }
    const maxDepthRaw = url.searchParams.get('maxDepth');
    const maxDepth = maxDepthRaw === null ? 1 : Number(maxDepthRaw);
    if (!Number.isInteger(maxDepth)) throw new HttpError(422, 'INVALID_ARGUMENT', 'maxDepth must be an integer');
    return json({ items: await relatedEntities(env, entityId, typeId, rawDirection as 'outgoing' | 'incoming' | 'both', maxDepth) });
  }

  return null;
}
