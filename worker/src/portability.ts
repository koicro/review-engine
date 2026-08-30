import { asNumber, batch, changed } from './db';
import { conflict, HttpError, json, nowIso, parseJson, requireUuid } from './http';
import { Scale } from './scale';

const FORMAT_VERSION = '1.2';
const DEFAULT_REVIEWER_ID = '00000000-0000-0000-0000-000000000001';
const MAX_ERRORS = 100;
const MAX_IMPORT_ROWS = 450;
const MAX_IMPORT_REQUEST_BYTES = 12_000_000;

type PortableRow = Record<string, unknown>;
type PortableData = Record<TableName, PortableRow[]>;

const tableDefinitions = {
  category: {
    columns: ['id', 'name', 'description', 'active_template_version_id', 'archived_at', 'created_at', 'updated_at', 'lock_version'],
    order: 'id', nullable: ['description', 'active_template_version_id', 'archived_at'], integers: ['lock_version'],
  },
  criterion: {
    columns: ['id', 'category_id', 'created_at'], order: 'id', nullable: [], integers: [],
  },
  template_version: {
    columns: ['id', 'category_id', 'version', 'status', 'published_at', 'created_at', 'updated_at', 'lock_version', 'properties_json'],
    order: 'category_id, version, id', nullable: ['published_at'], integers: ['version', 'lock_version'],
  },
  template_criterion: {
    columns: ['template_version_id', 'criterion_id', 'name', 'description', 'min_value', 'max_value', 'step_value', 'position', 'required'],
    order: 'template_version_id, position, criterion_id', nullable: ['description'], integers: ['position', 'required'],
  },
  entity: {
    columns: ['id', 'category_id', 'name', 'description', 'archived_at', 'created_at', 'updated_at', 'lock_version'],
    order: 'id', nullable: ['description', 'archived_at'], integers: ['lock_version'],
  },
  reviewer: {
    columns: ['id', 'display_name', 'archived_at', 'created_at'], order: 'id', nullable: ['archived_at'], integers: [],
  },
  review: {
    columns: ['id', 'entity_id', 'reviewer_id', 'template_version_id', 'reviewed_at', 'status', 'supersedes_review_id', 'created_at', 'updated_at', 'lock_version', 'hidden_at', 'properties_json'],
    order: 'id', nullable: ['supersedes_review_id', 'hidden_at'], integers: ['lock_version'],
  },
  score: {
    columns: ['review_id', 'criterion_id', 'tick_index'], order: 'review_id, criterion_id', nullable: [], integers: ['tick_index'],
  },
  relation_type: {
    columns: ['id', 'key', 'forward_label', 'inverse_label', 'hierarchical', 'created_at'], order: 'id', nullable: [], integers: ['hierarchical'],
  },
  entity_relation: {
    columns: ['id', 'source_entity_id', 'target_entity_id', 'relation_type_id', 'created_at'], order: 'id', nullable: [], integers: [],
  },
} as const;

type TableName = keyof typeof tableDefinitions;
const tableNames = Object.keys(tableDefinitions) as TableName[];
const importEmptyTables = [
  'category', 'criterion', 'template_version', 'template_criterion', 'entity', 'review', 'score',
  'picture_asset', 'review_picture', 'relation_type', 'entity_relation',
] as const;

interface ImportIssue { path: string; code: string; message: string }
interface ValidationResult {
  valid: boolean;
  errors: ImportIssue[];
  counts: Record<string, number>;
  formatVersion: string;
  data?: PortableData;
}

function addIssue(errors: ImportIssue[], path: string, code: string, message: string): void {
  if (errors.length < MAX_ERRORS) errors.push({ path, code, message });
}

function isObject(value: unknown): value is PortableRow {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { return requireUuid(value) === value.toLowerCase(); } catch { return false; }
}

function containsDirectedCycle(edges: Array<[string, string]>): boolean {
  const adjacency = new Map<string, string[]>();
  for (const [source, target] of edges) {
    const targets = adjacency.get(source) ?? [];
    targets.push(target);
    adjacency.set(source, targets);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const target of adjacency.get(node) ?? []) if (visit(target)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return [...adjacency.keys()].some(visit);
}

function validateDocument(payload: unknown): ValidationResult {
  const errors: ImportIssue[] = [];
  const counts: Record<string, number> = {};
  if (!isObject(payload)) {
    addIssue(errors, '$', 'INVALID_DOCUMENT', 'Import document must be a JSON object');
    return { valid: false, errors, counts, formatVersion: FORMAT_VERSION };
  }
  if (payload.format !== 'review-engine') addIssue(errors, '$.format', 'INVALID_FORMAT', 'Expected review-engine');
  const version = typeof payload.formatVersion === 'string' ? payload.formatVersion : '';
  if (!['1.0', '1.1', FORMAT_VERSION].includes(version)) {
    addIssue(errors, '$.formatVersion', 'UNSUPPORTED_VERSION', 'Supported format versions are 1.0, 1.1, 1.2');
  }
  if (!isObject(payload.data)) {
    addIssue(errors, '$.data', 'MISSING_DATA', 'The data object is required');
    return { valid: false, errors, counts, formatVersion: version || FORMAT_VERSION };
  }
  const data = {} as PortableData;
  let total = 0;
  for (const table of tableNames) {
    const rawRows = payload.data[table];
    if (!Array.isArray(rawRows)) {
      addIssue(errors, `$.data.${table}`, 'INVALID_TABLE', `${table} must be an array`);
      data[table] = [];
      continue;
    }
    counts[table] = rawRows.length;
    total += rawRows.length;
    data[table] = [];
    const definition = tableDefinitions[table];
    rawRows.forEach((raw, index) => {
      const path = `$.data.${table}[${index}]`;
      if (!isObject(raw)) { addIssue(errors, path, 'INVALID_ROW', 'Row must be an object'); return; }
      const row = { ...raw };
      if (table === 'review' && version === '1.0' && !Object.hasOwn(row, 'hidden_at')) row.hidden_at = null;
      if (table === 'template_version' && !Object.hasOwn(row, 'properties_json')) row.properties_json = '[]';
      if (table === 'review' && !Object.hasOwn(row, 'properties_json')) row.properties_json = '{}';
      const missing = definition.columns.filter((column) => !Object.hasOwn(row, column));
      const unknown = Object.keys(row).filter((column) => !(definition.columns as readonly string[]).includes(column));
      if (missing.length) addIssue(errors, path, 'MISSING_COLUMNS', `Missing columns: ${missing.join(', ')}`);
      if (unknown.length) addIssue(errors, path, 'UNKNOWN_COLUMNS', `Unknown columns: ${unknown.join(', ')}`);
      for (const column of definition.columns) {
        const value = row[column];
        const columnPath = `${path}.${column}`;
        if (value === null) {
          if (!definition.nullable.includes(column as never)) addIssue(errors, columnPath, 'NULL_NOT_ALLOWED', `${column} must not be null`);
          continue;
        }
        if (definition.integers.includes(column as never)) {
          if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
            addIssue(errors, columnPath, 'INVALID_TYPE', `${column} must be a non-negative JSON integer`);
          } else if ((column === 'required' || column === 'hierarchical') && value > 1) {
            addIssue(errors, columnPath, 'OUT_OF_RANGE', `${column} must be 0 or 1`);
          } else if (table === 'template_version' && column === 'version' && value < 1) {
            addIssue(errors, columnPath, 'OUT_OF_RANGE', 'version must be greater than zero');
          }
        } else if (typeof value !== 'string') {
          addIssue(errors, columnPath, 'INVALID_TYPE', `${column} must be a string`);
        }
        if (typeof value === 'string') {
          const maximum = column === 'description' ? 16_384
            : ['name', 'display_name', 'forward_label', 'inverse_label'].includes(column) ? 256
              : column === 'key' ? 64
                : ['min_value', 'max_value', 'step_value'].includes(column) ? 128
                  : (column.endsWith('_at') || column === 'reviewed_at') ? 64
                    : undefined;
          if (maximum !== undefined && value.length > maximum) {
            addIssue(errors, columnPath, 'TOO_LONG', `${column} must contain at most ${maximum} characters`);
          }
          if (['name', 'display_name', 'key', 'forward_label', 'inverse_label', 'min_value', 'max_value', 'step_value'].includes(column) && !value.trim()) {
            addIssue(errors, columnPath, 'BLANK_STRING', `${column} must not be blank`);
          }
        }
        if ((column === 'id' || column.endsWith('_id')) && value !== null && !isUuid(value)) {
          addIssue(errors, columnPath, 'INVALID_UUID', `${column} must be a canonical UUID`);
        }
        if ((column.endsWith('_at') || column === 'reviewed_at') && value !== null &&
          (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) {
          addIssue(errors, columnPath, 'INVALID_TIMESTAMP', `${column} must be an ISO 8601 timestamp`);
        }
      }
      data[table].push(row);
    });
  }
  if (total > MAX_IMPORT_ROWS) {
    addIssue(errors, '$.data', 'ROW_LIMIT_EXCEEDED', `Cloudflare imports support at most ${MAX_IMPORT_ROWS} rows per request`);
  }
  if (errors.length === 0) validateSemantics(data, errors);
  return { valid: errors.length === 0, errors, counts, formatVersion: version || FORMAT_VERSION, data };
}

function uniqueById(rows: PortableRow[], table: string, errors: ImportIssue[]): Map<string, PortableRow> {
  const result = new Map<string, PortableRow>();
  for (const row of rows) {
    const id = String(row.id);
    if (result.has(id)) addIssue(errors, `$.data.${table}`, 'CONSTRAINT_VIOLATION', `${table} contains a duplicate id`);
    result.set(id, row);
  }
  return result;
}

function validateSemantics(data: PortableData, errors: ImportIssue[]): void {
  const categories = uniqueById(data.category, 'category', errors);
  const criteria = uniqueById(data.criterion, 'criterion', errors);
  const templates = uniqueById(data.template_version, 'template_version', errors);
  const entities = uniqueById(data.entity, 'entity', errors);
  const reviewers = uniqueById(data.reviewer, 'reviewer', errors);
  const reviews = uniqueById(data.review, 'review', errors);
  const relationTypes = uniqueById(data.relation_type, 'relation_type', errors);
  uniqueById(data.entity_relation, 'entity_relation', errors);
  const defaultReviewer = reviewers.get(DEFAULT_REVIEWER_ID);
  if (!defaultReviewer || defaultReviewer.archived_at !== null) {
    addIssue(errors, '$.data.reviewer', 'CONFLICT', 'The active default reviewer is required');
  }
  for (const row of data.criterion) if (!categories.has(String(row.category_id))) {
    addIssue(errors, '$.data.criterion', 'CONSTRAINT_VIOLATION', 'A criterion references a missing category');
  }
  const templateVersions = new Set<string>();
  for (const row of data.template_version) {
    if (!categories.has(String(row.category_id))) addIssue(errors, '$.data.template_version', 'CONSTRAINT_VIOLATION', 'A template references a missing category');
    const versionKey = `${row.category_id}\u0000${row.version}`;
    if (templateVersions.has(versionKey)) addIssue(errors, '$.data.template_version', 'CONSTRAINT_VIOLATION', 'Template versions must be unique within a category');
    templateVersions.add(versionKey);
    if (!['draft', 'published', 'retired'].includes(String(row.status))) addIssue(errors, '$.data.template_version', 'INVALID_VALUE', 'Template status is invalid');
    if ((row.status === 'draft') !== (row.published_at === null)) {
      addIssue(errors, '$.data.template_version', 'INVALID_STATE_TRANSITION', 'Draft templates must not have a publication time and published templates must have one');
    }
  }
  const criteriaByTemplate = new Map<string, PortableRow[]>();
  const templateCriterionKeys = new Set<string>();
  const templatePositions = new Set<string>();
  for (const row of data.template_criterion) {
    const template = templates.get(String(row.template_version_id));
    const criterion = criteria.get(String(row.criterion_id));
    if (!template || !criterion) addIssue(errors, '$.data.template_criterion', 'CONSTRAINT_VIOLATION', 'A template criterion references missing data');
    else if (template.category_id !== criterion.category_id) addIssue(errors, '$.data.template_criterion', 'CATEGORY_MISMATCH', 'A template criterion must belong to the template category');
    const criterionKey = `${row.template_version_id}\u0000${row.criterion_id}`;
    const positionKey = `${row.template_version_id}\u0000${row.position}`;
    if (templateCriterionKeys.has(criterionKey) || templatePositions.has(positionKey)) {
      addIssue(errors, '$.data.template_criterion', 'CONSTRAINT_VIOLATION', 'Template criteria and positions must be unique');
    }
    templateCriterionKeys.add(criterionKey);
    templatePositions.add(positionKey);
    try { new Scale(String(row.min_value), String(row.max_value), String(row.step_value)); }
    catch (error) { addIssue(errors, '$.data.template_criterion', error instanceof HttpError ? error.code : 'INVALID_SCALE', 'Template criterion scale is invalid'); }
    const list = criteriaByTemplate.get(String(row.template_version_id)) ?? [];
    list.push(row); criteriaByTemplate.set(String(row.template_version_id), list);
  }
  for (const [templateId, rows] of criteriaByTemplate) if (rows.length > 100) {
    addIssue(errors, '$.data.template_criterion', 'CRITERION_LIMIT_EXCEEDED', `Template ${templateId} exceeds 100 criteria`);
  }
  for (const row of data.category) {
    if (row.active_template_version_id !== null) {
      const template = templates.get(String(row.active_template_version_id));
      if (!template || template.category_id !== row.id || template.status !== 'published') {
        addIssue(errors, '$.data.category', 'CONFLICT', 'A category active template must be a published version from that category');
      }
    }
  }
  for (const row of data.entity) if (!categories.has(String(row.category_id))) {
    addIssue(errors, '$.data.entity', 'CONSTRAINT_VIOLATION', 'An entity references a missing category');
  }
  const scoresByReview = new Map<string, PortableRow[]>();
  const scoreKeys = new Set<string>();
  for (const score of data.score) {
    const key = `${score.review_id}\u0000${score.criterion_id}`;
    if (scoreKeys.has(key)) addIssue(errors, '$.data.score', 'CONSTRAINT_VIOLATION', 'Scores must be unique per review criterion');
    scoreKeys.add(key);
    const list = scoresByReview.get(String(score.review_id)) ?? [];
    list.push(score); scoresByReview.set(String(score.review_id), list);
  }
  const replacementsByOriginal = new Map<string, PortableRow>();
  const revisionEdges: Array<[string, string]> = [];
  for (const row of data.review) {
    const entity = entities.get(String(row.entity_id));
    const template = templates.get(String(row.template_version_id));
    if (!entity || !template || !reviewers.has(String(row.reviewer_id))) {
      addIssue(errors, '$.data.review', 'CONSTRAINT_VIOLATION', 'A review references missing data'); continue;
    }
    if (entity.category_id !== template.category_id || template.status === 'draft') {
      addIssue(errors, '$.data.review', 'CATEGORY_MISMATCH', 'A review must use a published or retired template from its entity category');
    }
    if (!['draft', 'final', 'superseded'].includes(String(row.status))) {
      addIssue(errors, '$.data.review', 'INVALID_VALUE', 'Review status is invalid');
    }
    if (row.status === 'draft' && row.hidden_at !== null) addIssue(errors, '$.data.review', 'INVALID_STATE_TRANSITION', 'Draft reviews cannot be hidden');
    if (row.supersedes_review_id !== null) {
      const originalId = String(row.supersedes_review_id);
      const original = reviews.get(originalId);
      if (!original) {
        addIssue(errors, '$.data.review', 'CONSTRAINT_VIOLATION', 'A review supersedes missing data');
      } else if (!['final', 'superseded'].includes(String(row.status)) || original.status !== 'superseded' ||
        original.entity_id !== row.entity_id || original.template_version_id !== row.template_version_id) {
        addIssue(errors, '$.data.review', 'INVALID_STATE_TRANSITION', 'A review revision chain is inconsistent');
      }
      if (replacementsByOriginal.has(originalId)) {
        addIssue(errors, '$.data.review', 'CONSTRAINT_VIOLATION', 'A review can have only one replacement');
      }
      replacementsByOriginal.set(originalId, row);
      revisionEdges.push([String(row.id), originalId]);
    }
    const definitions = new Map((criteriaByTemplate.get(String(row.template_version_id)) ?? []).map((item) => [String(item.criterion_id), item]));
    const supplied = new Set<string>();
    for (const score of scoresByReview.get(String(row.id)) ?? []) {
      const definition = definitions.get(String(score.criterion_id));
      if (!definition || supplied.has(String(score.criterion_id))) addIssue(errors, '$.data.score', 'UNKNOWN_CRITERION', 'A score criterion is invalid for its review');
      else {
        supplied.add(String(score.criterion_id));
        try { new Scale(String(definition.min_value), String(definition.max_value), String(definition.step_value)).requireTick(score.tick_index); }
        catch { addIssue(errors, '$.data.score', 'INVALID_TICK_INDEX', 'A score tick is outside its scale'); }
      }
    }
    if (['final', 'superseded'].includes(String(row.status))) {
      const missing = [...definitions.values()].find((definition) => definition.required === 1 && !supplied.has(String(definition.criterion_id)));
      if (missing) addIssue(errors, '$.data.review', 'REQUIRED_SCORE_MISSING', 'A final review is missing a required score');
    }
  }
  for (const row of data.review) if (row.status === 'superseded' && !replacementsByOriginal.has(String(row.id))) {
    addIssue(errors, '$.data.review', 'INVALID_STATE_TRANSITION', 'A superseded review has no replacement');
  }
  if (containsDirectedCycle(revisionEdges)) {
    addIssue(errors, '$.data.review', 'INVALID_STATE_TRANSITION', 'Review revision chains cannot contain a cycle');
  }
  for (const score of data.score) if (!reviews.has(String(score.review_id)) || !criteria.has(String(score.criterion_id))) {
    addIssue(errors, '$.data.score', 'CONSTRAINT_VIOLATION', 'A score references missing data');
  }
  const relationKeys = new Set<string>();
  const relationTypeKeys = new Set<string>();
  for (const type of data.relation_type) {
    const key = String(type.key);
    if (relationTypeKeys.has(key)) addIssue(errors, '$.data.relation_type', 'CONSTRAINT_VIOLATION', 'Relation type keys must be unique');
    relationTypeKeys.add(key);
  }
  const hierarchicalEdges = new Map<string, Array<[string, string]>>();
  for (const row of data.entity_relation) {
    const typeId = String(row.relation_type_id);
    const type = relationTypes.get(typeId);
    if (!entities.has(String(row.source_entity_id)) || !entities.has(String(row.target_entity_id)) || !type) {
      addIssue(errors, '$.data.entity_relation', 'CONSTRAINT_VIOLATION', 'A relation references missing data');
      continue;
    }
    const key = `${row.source_entity_id}\u0000${row.target_entity_id}\u0000${typeId}`;
    if (relationKeys.has(key)) addIssue(errors, '$.data.entity_relation', 'CONSTRAINT_VIOLATION', 'Relations must be unique');
    relationKeys.add(key);
    if (type.hierarchical === 1) {
      const edges = hierarchicalEdges.get(typeId) ?? [];
      edges.push([String(row.source_entity_id), String(row.target_entity_id)]);
      hierarchicalEdges.set(typeId, edges);
    }
  }
  for (const [typeId, edges] of hierarchicalEdges) if (containsDirectedCycle(edges)) {
    addIssue(errors, '$.data.entity_relation', 'HIERARCHY_CYCLE', `Hierarchical relation type ${typeId} contains a cycle`);
  }
}

async function exportData(database: D1Database): Promise<PortableData> {
  const snapshots = await batch(database, tableNames.map((table) => {
    const definition = tableDefinitions[table];
    return database.prepare(`SELECT ${definition.columns.join(', ')} FROM ${table} ORDER BY ${definition.order}`);
  }));
  const result = {} as PortableData;
  tableNames.forEach((table, index) => { result[table] = (snapshots[index]?.results ?? []) as PortableRow[]; });
  return result;
}

async function ensureImportTargetEmpty(database: D1Database): Promise<void> {
  for (const table of importEmptyTables) {
    const count = await database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<number>('count');
    if (asNumber(count ?? 0) > 0) conflict('Imports can only restore into an empty database', { table });
  }
}

function insertStatement(database: D1Database, table: TableName, row: PortableRow, importId: string): D1PreparedStatement {
  const definition = tableDefinitions[table];
  const columns = definition.columns;
  const values = columns.map((column) => {
    if (table === 'category' && column === 'active_template_version_id') return null;
    if (table === 'review' && column === 'supersedes_review_id') return null;
    return row[column] ?? null;
  });
  return database.prepare(
    `INSERT INTO ${table}(${columns.join(', ')})
     SELECT ${columns.map(() => '?').join(', ')} WHERE EXISTS (SELECT 1 FROM import_lock WHERE id = ?)`,
  ).bind(...values, importId);
}

async function importData(database: D1Database, data: PortableData): Promise<void> {
  await ensureImportTargetEmpty(database);
  const importId = crypto.randomUUID();
  const emptyGuard = importEmptyTables.map((table) => `NOT EXISTS (SELECT 1 FROM ${table})`).join(' AND ');
  const statements: D1PreparedStatement[] = [
    database.prepare(
      `INSERT INTO import_lock(id, created_at)
       SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM import_lock) AND ${emptyGuard}`,
    ).bind(importId, nowIso()),
    database.prepare('DELETE FROM reviewer WHERE EXISTS (SELECT 1 FROM import_lock WHERE id = ?)').bind(importId),
  ];
  for (const table of tableNames) for (const row of data[table]) statements.push(insertStatement(database, table, row, importId));
  for (const row of data.category) if (row.active_template_version_id !== null) {
    statements.push(database.prepare(
      'UPDATE category SET active_template_version_id = ? WHERE id = ? AND EXISTS (SELECT 1 FROM import_lock WHERE id = ?)',
    ).bind(row.active_template_version_id, row.id, importId));
  }
  for (const row of data.review) if (row.supersedes_review_id !== null) {
    statements.push(database.prepare(
      'UPDATE review SET supersedes_review_id = ? WHERE id = ? AND EXISTS (SELECT 1 FROM import_lock WHERE id = ?)',
    ).bind(row.supersedes_review_id, row.id, importId));
  }
  statements.push(
    database.prepare('DELETE FROM web_session WHERE EXISTS (SELECT 1 FROM import_lock WHERE id = ?)').bind(importId),
    database.prepare('DELETE FROM import_lock WHERE id = ?').bind(importId),
  );
  let results: D1Result[];
  try { results = await batch(database, statements); }
  catch (error) {
    throw new HttpError(422, 'IMPORT_INVALID', 'Imported rows violate schema or reference constraints', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (changed(results[0]!) !== 1) conflict('Imports can only restore into an empty database');
}

export async function handlePortabilityRoutes(
  request: Request,
  env: Env,
  path: string[],
  method: string,
): Promise<Response | null> {
  if (path.length === 1 && path[0] === 'exports' && method === 'POST') {
    const document = { format: 'review-engine', formatVersion: FORMAT_VERSION, exportedAt: nowIso(), data: await exportData(env.DB) };
    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="review-engine-${nowIso()}.json"`,
      'Cache-Control': 'no-store',
    });
    return new Response(JSON.stringify(document), { headers });
  }
  if (path[0] !== 'imports') return null;
  const payload = await parseJson<unknown>(request, MAX_IMPORT_REQUEST_BYTES);
  const validation = validateDocument(payload);
  if (path.length === 2 && path[1] === 'validate' && method === 'POST') {
    const { data: _data, ...response } = validation;
    return json(response);
  }
  if (path.length === 1 && method === 'POST') {
    if (!validation.valid || !validation.data) {
      throw new HttpError(422, 'IMPORT_INVALID', 'Import validation failed', {
        errors: validation.errors.map((error) => `${error.path}: ${error.message}`).join('; '),
      });
    }
    await importData(env.DB, validation.data);
    return json({ imported: true, counts: validation.counts });
  }
  return null;
}
