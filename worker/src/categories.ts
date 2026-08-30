import {
  HttpError,
  booleanQuery,
  conflict,
  decodeCursor,
  encodeCursor,
  json,
  noContent,
  normalizeLimit,
  nowIso,
  optimisticConflict,
  optionalText,
  parseJson,
  requireInteger,
  requireNonBlank,
  requireObject,
  requireString,
  requireUuid,
} from './http';
import { Scale } from './scale';
import { type DbRow, all, asBoolean, asNumber, batch, changed, one, run } from './db';

interface CategoryRow extends DbRow {
  id: string;
  name: string;
  description: string | null;
  active_template_version_id: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  lock_version: number;
}

interface TemplateVersionRow extends DbRow {
  id: string;
  category_id: string;
  version: number;
  status: 'draft' | 'published' | 'retired';
  published_at: string | null;
  created_at: string;
  updated_at: string;
  lock_version: number;
  properties_json?: string;
}

export type PropertyType = 'text' | 'select' | 'checkbox';
export interface PropertyDefinition {
  id: string;
  name: string;
  description?: string;
  type: PropertyType;
  options: string[];
  position: number;
  required: boolean;
}

interface TemplateJoinRow extends TemplateVersionRow {
  criterion_id: string | null;
  criterion_name: string | null;
  criterion_description: string | null;
  min_value: string | null;
  max_value: string | null;
  step_value: string | null;
  criterion_position: number | null;
  criterion_required: number | null;
}

interface CriterionShape {
  criterionId: string | null;
  name: string;
  description: string | null;
  minValue: string;
  maxValue: string;
  stepValue: string;
  position: number;
  required: boolean;
}

interface PreparedCriterion extends CriterionShape {
  criterionId: string;
}

interface TemplateSnapshot {
  version: TemplateVersionRow;
  criteria: Array<{
    id: string;
    criterionId: string;
    name: string;
    description?: string;
    minValue: string;
    maxValue: string;
    stepValue: string;
    position: number;
    required: boolean;
  }>;
  properties: PropertyDefinition[];
}

type BindValue = string | number | null;

const CATEGORY_FIELDS = new Set(['name', 'description']);
const CATEGORY_PATCH_FIELDS = new Set(['name', 'description', 'archived', 'revision']);
const TEMPLATE_CREATE_FIELDS = new Set(['criteria', 'properties']);
const TEMPLATE_PATCH_FIELDS = new Set(['criteria', 'properties', 'revision']);
const REVISION_FIELDS = new Set(['revision']);
const CRITERION_FIELDS = new Set([
  'id',
  'criterionId',
  'name',
  'description',
  'minValue',
  'maxValue',
  'stepValue',
  'position',
  'required',
]);

export async function handleCategoryRoutes(
  request: Request,
  env: Env,
  path: string[],
  method: string,
): Promise<Response | null> {
  if (path[0] === 'categories' && path.length === 1) {
    if (method === 'GET') return listCategories(request, env);
    if (method === 'POST') return createCategory(request, env);
    return methodNotAllowed();
  }

  if (path[0] === 'categories' && path.length === 2) {
    const categoryId = requireUuid(path[1], 'categoryId');
    if (method === 'GET') return json(categoryDto(await getCategory(env, categoryId)));
    if (method === 'PATCH') return updateCategory(request, env, categoryId);
    if (method === 'DELETE') return deleteCategory(env, categoryId);
    return methodNotAllowed();
  }

  if (path[0] === 'categories' && path[2] === 'template-versions' && path.length === 3) {
    const categoryId = requireUuid(path[1], 'categoryId');
    if (method === 'GET') return listTemplateVersions(env, categoryId);
    if (method === 'POST') return createTemplateDraft(request, env, categoryId);
    return methodNotAllowed();
  }

  if (path[0] === 'template-versions' && path.length === 2) {
    const versionId = requireUuid(path[1], 'versionId');
    if (method === 'GET') return json(templateDto(await getTemplateSnapshot(env, versionId)));
    if (method === 'PATCH') return updateTemplateDraft(request, env, versionId);
    return methodNotAllowed();
  }

  if (path[0] === 'template-versions' && path[2] === 'publish' && path.length === 3) {
    const versionId = requireUuid(path[1], 'versionId');
    if (method === 'POST') return publishTemplate(request, env, versionId);
    return methodNotAllowed();
  }

  return null;
}

async function listCategories(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const offset = decodeCursor(url.searchParams.get('cursor'));
  const pageSize = normalizeLimit(url.searchParams.get('limit'));
  const includeArchived = booleanQuery(url, 'includeArchived');
  const where = includeArchived ? '' : 'WHERE archived_at IS NULL';
  const rows = await all<CategoryRow>(
    env.DB.prepare(
      `SELECT * FROM category ${where} ORDER BY lower(name), id LIMIT ? OFFSET ?`,
    ).bind(pageSize + 1, offset),
  );
  const hasNext = rows.length > pageSize;
  const body: { items: ReturnType<typeof categoryDto>[]; nextCursor?: string } = {
    items: rows.slice(0, pageSize).map(categoryDto),
  };
  if (hasNext) body.nextCursor = encodeCursor(offset + pageSize);
  return json(body);
}

async function createCategory(request: Request, env: Env): Promise<Response> {
  const body = requireObject(await parseJson<unknown>(request));
  assertFields(body, CATEGORY_FIELDS);
  const name = requireNonBlank(body.name, 'name');
  const description = optionalText(body.description, 'description');
  const id = crypto.randomUUID();
  const timestamp = nowIso();
  await run(
    env.DB.prepare(
      `INSERT INTO category(
         id, name, description, active_template_version_id, archived_at, created_at, updated_at, lock_version
       ) VALUES (?, ?, ?, NULL, NULL, ?, ?, 0)`,
    ).bind(id, name, description, timestamp, timestamp),
  );
  return json(categoryDto(await getCategory(env, id)), 201);
}

async function updateCategory(request: Request, env: Env, categoryId: string): Promise<Response> {
  const body = requireObject(await parseJson<unknown>(request));
  assertFields(body, CATEGORY_PATCH_FIELDS);
  const patch = parseCategoryPatch(body);
  const current = await getCategory(env, categoryId);

  if (patch.revision !== null && patch.revision !== asNumber(current.lock_version)) {
    optimisticConflict('Category', categoryId, patch.revision, asNumber(current.lock_version));
  }

  const name = patch.name === null ? current.name : requireNonBlank(patch.name, 'name');
  const description = patch.descriptionSpecified
    ? optionalText(patch.description, 'description')
    : current.description;
  const archivedAt = patch.archived === true
    ? current.archived_at ?? nowIso()
    : patch.archived === false
      ? null
      : current.archived_at;
  const changedValue = name !== current.name
    || description !== current.description
    || archivedAt !== current.archived_at;
  if (!changedValue) return json(categoryDto(current));

  const timestamp = nowIso();
  const expected = asNumber(current.lock_version);
  const result = await run(
    env.DB.prepare(
      `UPDATE category
       SET name = ?, description = ?, archived_at = ?, updated_at = ?, lock_version = lock_version + 1
       WHERE id = ? AND lock_version = ?`,
    ).bind(name, description, archivedAt, timestamp, categoryId, expected),
  );
  if (changed(result) !== 1) {
    const actual = await maybeCategoryRevision(env, categoryId);
    if (actual === null) await getCategory(env, categoryId);
    optimisticConflict('Category', categoryId, expected, actual ?? undefined);
  }
  return json(categoryDto(await getCategory(env, categoryId)));
}

async function deleteCategory(env: Env, categoryId: string): Promise<Response> {
  await getCategory(env, categoryId);
  const result = await run(env.DB.prepare('DELETE FROM category WHERE id = ?').bind(categoryId));
  if (changed(result) !== 1) await getCategory(env, categoryId);
  return noContent();
}

async function listTemplateVersions(env: Env, categoryId: string): Promise<Response> {
  await getCategory(env, categoryId);
  const rows = await templateRows(
    env,
    `WHERE tv.category_id = ? ORDER BY tv.version DESC, tc.position, tc.criterion_id`,
    [categoryId],
  );
  return json({ items: groupTemplateRows(rows).map(templateDto) });
}

async function createTemplateDraft(request: Request, env: Env, categoryId: string): Promise<Response> {
  const body = requireObject(await parseJson<unknown>(request));
  assertFields(body, TEMPLATE_CREATE_FIELDS);
  const criterionShapes = parseOptionalCriteria(body.criteria);
  const category = await getCategory(env, categoryId);
  if (category.archived_at !== null) {
    conflict('Archived categories cannot receive template versions', { categoryId });
  }

  const criteria = criterionShapes === null ? null : prepareCriteria(criterionShapes);
  const parsedProperties = parseOptionalProperties(body.properties);
  if (criteria !== null) await assertCriterionCategories(env, categoryId, criteria);
  const inheritedProperties = parsedProperties === null && category.active_template_version_id
    ? storedProperties((await getTemplateVersion(env, category.active_template_version_id)).properties_json)
    : [];
  const properties = parsedProperties ?? inheritedProperties;

  const versionId = crypto.randomUUID();
  const timestamp = nowIso();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO template_version(
         id, category_id, version, status, published_at, created_at, updated_at, lock_version, properties_json
       )
       SELECT ?, c.id,
              COALESCE((SELECT MAX(existing.version) FROM template_version existing WHERE existing.category_id = c.id), 0) + 1,
              'draft', NULL, ?, ?, 0, ?
       FROM category c
       WHERE c.id = ? AND c.archived_at IS NULL`,
    ).bind(versionId, timestamp, timestamp, JSON.stringify(properties), categoryId),
  ];

  if (criteria === null) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO template_criterion(
           template_version_id, criterion_id, name, description,
           min_value, max_value, step_value, position, required
         )
         SELECT ?, tc.criterion_id, tc.name, tc.description,
                tc.min_value, tc.max_value, tc.step_value, tc.position, tc.required
         FROM category c
         JOIN template_criterion tc ON tc.template_version_id = c.active_template_version_id
         WHERE c.id = ? AND EXISTS (SELECT 1 FROM template_version WHERE id = ?)`,
      ).bind(versionId, categoryId, versionId),
    );
  } else {
    statements.push(...criterionWriteStatements(
      env,
      criteria,
      categoryId,
      versionId,
      timestamp,
      'EXISTS (SELECT 1 FROM template_version guarded WHERE guarded.id = ?)',
      [versionId],
    ));
  }

  const results = await batch(env.DB, statements);
  const insert = results[0];
  if (!insert || changed(insert) !== 1) {
    const latest = await getCategory(env, categoryId);
    if (latest.archived_at !== null) {
      conflict('Archived categories cannot receive template versions', { categoryId });
    }
    conflict('The write conflicts with existing data');
  }
  return json(templateDto(await getTemplateSnapshot(env, versionId)), 201);
}

async function updateTemplateDraft(request: Request, env: Env, versionId: string): Promise<Response> {
  const body = requireObject(await parseJson<unknown>(request));
  assertFields(body, TEMPLATE_PATCH_FIELDS);
  if (!Array.isArray(body.criteria)) invalidJsonField('criteria');
  const criterionShapes = body.criteria.map((value) => parseCriterionShape(value));
  const revision = requireInteger(body.revision, 'revision');
  const current = await getTemplateVersion(env, versionId);
  requireDraftEditable(current);
  if (revision !== asNumber(current.lock_version)) {
    optimisticConflict('Template version', versionId, revision, asNumber(current.lock_version));
  }

  const criteria = prepareCriteria(criterionShapes);
  const properties = parseOptionalProperties(body.properties) ?? storedProperties(current.properties_json);
  await assertCriterionCategories(env, current.category_id, criteria);
  const timestamp = nowIso();
  const guardSql = `EXISTS (
    SELECT 1 FROM template_version guarded
    WHERE guarded.id = ? AND guarded.status = 'draft' AND guarded.lock_version = ?
  )`;
  const guardValues: BindValue[] = [versionId, revision];
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `DELETE FROM template_criterion
       WHERE template_version_id = ? AND ${guardSql}`,
    ).bind(versionId, ...guardValues),
    ...criterionWriteStatements(
      env,
      criteria,
      current.category_id,
      versionId,
      timestamp,
      guardSql,
      guardValues,
    ),
    env.DB.prepare(
      `UPDATE template_version
       SET properties_json = ?, updated_at = ?, lock_version = lock_version + 1
       WHERE id = ? AND status = 'draft' AND lock_version = ?`,
    ).bind(JSON.stringify(properties), timestamp, versionId, revision),
  ];
  const results = await batch(env.DB, statements);
  const update = results[results.length - 1];
  if (!update || changed(update) !== 1) {
    const actual = await getTemplateVersion(env, versionId);
    requireDraftEditable(actual);
    optimisticConflict('Template version', versionId, revision, asNumber(actual.lock_version));
  }
  return json(templateDto(await getTemplateSnapshot(env, versionId)));
}

async function publishTemplate(request: Request, env: Env, versionId: string): Promise<Response> {
  const body = requireObject(await parseJson<unknown>(request));
  assertFields(body, REVISION_FIELDS);
  const revision = requireInteger(body.revision, 'revision');
  const current = await getTemplateVersion(env, versionId);
  if (current.status !== 'draft') {
    throw new HttpError(409, 'IMMUTABLE_RESOURCE', 'Only a draft template can be published');
  }
  if (revision !== asNumber(current.lock_version)) {
    optimisticConflict('Template version', versionId, revision, asNumber(current.lock_version));
  }
  const criterionCount = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM template_criterion WHERE template_version_id = ?',
  ).bind(versionId).first<number>('count');
  if (asNumber(criterionCount ?? 0) === 0) {
    const actual = await getTemplateVersion(env, versionId);
    if (actual.status !== 'draft') {
      throw new HttpError(409, 'IMMUTABLE_RESOURCE', 'Only a draft template can be published');
    }
    if (asNumber(actual.lock_version) !== revision) {
      optimisticConflict('Template version', versionId, revision, asNumber(actual.lock_version));
    }
    throw new HttpError(422, 'INVALID_ARGUMENT', 'A template must contain at least one criterion');
  }
  const category = await getCategory(env, current.category_id);
  if (category.archived_at !== null) {
    conflict('Archived categories cannot publish templates', { categoryId: category.id });
  }

  const timestamp = nowIso();
  const categoryRevision = asNumber(category.lock_version);
  const previousId = category.active_template_version_id;
  const guardSql = `EXISTS (
    SELECT 1
    FROM template_version guarded
    JOIN category guarded_category ON guarded_category.id = guarded.category_id
    WHERE guarded.id = ?
      AND guarded.status = 'draft'
      AND guarded.lock_version = ?
      AND EXISTS (SELECT 1 FROM template_criterion required_criterion WHERE required_criterion.template_version_id = guarded.id)
      AND guarded_category.archived_at IS NULL
      AND guarded_category.lock_version = ?
      AND guarded_category.active_template_version_id IS ?
  )`;
  const guardValues: BindValue[] = [versionId, revision, categoryRevision, previousId];
  const statements: D1PreparedStatement[] = [];
  if (previousId !== null && previousId !== versionId) {
    statements.push(
      env.DB.prepare(
        `UPDATE template_version
         SET status = 'retired', updated_at = ?, lock_version = lock_version + 1
         WHERE id = ? AND status = 'published' AND ${guardSql}`,
      ).bind(timestamp, previousId, ...guardValues),
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE template_version
       SET status = 'published', published_at = ?, updated_at = ?, lock_version = lock_version + 1
       WHERE id = ? AND status = 'draft' AND lock_version = ? AND ${guardSql}`,
    ).bind(timestamp, timestamp, versionId, revision, ...guardValues),
  );
  const publishIndex = statements.length - 1;
  statements.push(
    env.DB.prepare(
      `UPDATE category
       SET active_template_version_id = ?, updated_at = ?, lock_version = lock_version + 1
       WHERE id = ?
         AND archived_at IS NULL
         AND lock_version = ?
         AND active_template_version_id IS ?
         AND EXISTS (
           SELECT 1 FROM template_version published
           WHERE published.id = ?
             AND published.status = 'published'
             AND published.lock_version = ?
             AND published.published_at = ?
         )`,
    ).bind(
      versionId,
      timestamp,
      current.category_id,
      categoryRevision,
      previousId,
      versionId,
      revision + 1,
      timestamp,
    ),
  );

  const results = await batch(env.DB, statements);
  const publishResult = results[publishIndex];
  const categoryResult = results[results.length - 1];
  if (!publishResult || !categoryResult || changed(publishResult) !== 1 || changed(categoryResult) !== 1) {
    const actual = await getTemplateVersion(env, versionId);
    if (actual.status !== 'draft') {
      throw new HttpError(409, 'IMMUTABLE_RESOURCE', 'Only a draft template can be published');
    }
    if (asNumber(actual.lock_version) !== revision) {
      optimisticConflict('Template version', versionId, revision, asNumber(actual.lock_version));
    }
    const latestCategory = await getCategory(env, actual.category_id);
    if (latestCategory.archived_at !== null) {
      conflict('Archived categories cannot publish templates', { categoryId: latestCategory.id });
    }
    conflict('The write conflicts with existing data', { retryable: 'true' });
  }
  return json(templateDto(await getTemplateSnapshot(env, versionId)));
}

function criterionWriteStatements(
  env: Env,
  criteria: PreparedCriterion[],
  categoryId: string,
  versionId: string,
  timestamp: string,
  guardSql: string,
  guardValues: BindValue[],
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const criterion of criteria) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO criterion(id, category_id, created_at)
         SELECT ?, ?, ?
         WHERE ${guardSql}
           AND NOT EXISTS (SELECT 1 FROM criterion existing WHERE existing.id = ?)`,
      ).bind(
        criterion.criterionId,
        categoryId,
        timestamp,
        ...guardValues,
        criterion.criterionId,
      ),
      env.DB.prepare(
        `INSERT INTO template_criterion(
           template_version_id, criterion_id, name, description,
           min_value, max_value, step_value, position, required
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ${guardSql}`,
      ).bind(
        versionId,
        criterion.criterionId,
        criterion.name,
        criterion.description,
        criterion.minValue,
        criterion.maxValue,
        criterion.stepValue,
        criterion.position,
        criterion.required ? 1 : 0,
        ...guardValues,
      ),
    );
  }
  return statements;
}

async function assertCriterionCategories(
  env: Env,
  categoryId: string,
  criteria: PreparedCriterion[],
): Promise<void> {
  const ids = criteria.map((criterion) => criterion.criterionId);
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await all<{ id: string; category_id: string } & DbRow>(
      env.DB.prepare(
        `SELECT id, category_id FROM criterion WHERE id IN (${placeholders})`,
      ).bind(...chunk),
    );
    const mismatch = rows.find((row) => row.category_id !== categoryId);
    if (mismatch) {
      conflict('Criterion IDs cannot cross category boundaries', { criterionId: mismatch.id });
    }
  }
}

function parseOptionalCriteria(value: unknown): CriterionShape[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) invalidJsonField('criteria');
  return value.map((criterion) => parseCriterionShape(criterion));
}

function parseOptionalProperties(value: unknown): PropertyDefinition[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) invalidJsonField('properties');
  const positions = new Set<number>();
  const names = new Set<string>();
  return value.map((raw, index) => {
    const body = requireObject(raw);
    assertFields(body, new Set(['id', 'name', 'description', 'type', 'options', 'position', 'required']));
    const name = requireNonBlank(body.name, `properties[${index}].name`);
    const type = body.type;
    if (type !== 'text' && type !== 'select' && type !== 'checkbox') invalidJsonField(`properties[${index}].type`);
    const position = requireInteger(body.position, `properties[${index}].position`, 0);
    if (positions.has(position)) throw new HttpError(422, 'INVALID_ARGUMENT', 'Property positions must be unique', { field: 'properties' });
    positions.add(position);
    const nameKey = name.toLocaleLowerCase();
    if (names.has(nameKey)) throw new HttpError(422, 'INVALID_ARGUMENT', 'Property names must be unique', { field: 'properties' });
    names.add(nameKey);
    const id = body.id === undefined || body.id === null ? crypto.randomUUID() : requireUuid(body.id, `properties[${index}].id`);
    const description = body.description === undefined || body.description === null ? undefined : optionalText(body.description, `properties[${index}].description`) ?? undefined;
    if (typeof body.required !== 'boolean') invalidJsonField(`properties[${index}].required`);
    const options = body.options === undefined || body.options === null ? [] : body.options;
    if (!Array.isArray(options) || options.some((option) => typeof option !== 'string' || !option.trim())) invalidJsonField(`properties[${index}].options`);
    if (type === 'select' && options.length === 0) throw new HttpError(422, 'INVALID_ARGUMENT', 'Select properties need at least one option', { field: `properties[${index}].options` });
    if (type !== 'select' && options.length > 0) invalidJsonField(`properties[${index}].options`);
    return { id, name, ...(description ? { description } : {}), type, options: options.map((option) => option.trim()), position, required: body.required };
  });
}

function storedProperties(value: unknown): PropertyDefinition[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as PropertyDefinition[] : [];
  } catch { return []; }
}

function parseCriterionShape(value: unknown): CriterionShape {
  const body = requireObject(value);
  assertFields(body, CRITERION_FIELDS);
  if (body.id !== undefined && body.id !== null && typeof body.id !== 'string') invalidJsonField('id');
  if (body.criterionId !== undefined && body.criterionId !== null && typeof body.criterionId !== 'string') {
    invalidJsonField('criterionId');
  }
  const selectedId = body.criterionId ?? body.id;
  const criterionId = selectedId === undefined || selectedId === null
    ? null
    : requireUuid(selectedId, 'criterionId');
  const name = requireString(body.name, 'criterion.name');
  const description = body.description === undefined || body.description === null
    ? null
    : requireString(body.description, 'criterion.description');
  const minValue = body.minValue === undefined
    ? '0'
    : requireString(body.minValue, 'minValue');
  const maxValue = requireString(body.maxValue, 'maxValue');
  const stepValue = requireString(body.stepValue, 'stepValue');
  const position = requireInteger(body.position, 'position');
  if (typeof body.required !== 'boolean') invalidJsonField('required');
  return {
    criterionId,
    name,
    description,
    minValue,
    maxValue,
    stepValue,
    position,
    required: body.required,
  };
}

function prepareCriteria(shapes: CriterionShape[]): PreparedCriterion[] {
  const seenIds = new Set<string>();
  for (const criterion of shapes) {
    if (criterion.criterionId !== null && seenIds.has(criterion.criterionId)) {
      throw new HttpError(422, 'DUPLICATE_CRITERION', 'A criterion can only occur once', {
        criterionId: criterion.criterionId,
      });
    }
    if (criterion.criterionId !== null) seenIds.add(criterion.criterionId);
  }
  const positions = new Set<number>();
  for (const criterion of shapes) {
    if (criterion.position < 0 || positions.has(criterion.position)) {
      throw new HttpError(422, 'INVALID_ARGUMENT', 'Criterion positions must be unique and non-negative');
    }
    positions.add(criterion.position);
  }

  return shapes.map((criterion) => {
    const name = requireNonBlank(criterion.name, 'criterion.name');
    const description = optionalText(criterion.description, 'criterion.description');
    const scale = new Scale(criterion.minValue, criterion.maxValue, criterion.stepValue);
    return {
      ...criterion,
      criterionId: criterion.criterionId ?? crypto.randomUUID(),
      name,
      description,
      minValue: scale.minValue(),
      maxValue: scale.maxValue(),
      stepValue: scale.stepValue(),
    };
  });
}

function parseCategoryPatch(body: Record<string, unknown>): {
  name: string | null;
  description: string | null;
  descriptionSpecified: boolean;
  archived: boolean | null;
  revision: number | null;
} {
  if (body.name !== undefined && body.name !== null && typeof body.name !== 'string') invalidJsonField('name');
  if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
    invalidJsonField('description');
  }
  if (body.archived !== undefined && body.archived !== null && typeof body.archived !== 'boolean') {
    invalidJsonField('archived');
  }
  return {
    name: typeof body.name === 'string' ? body.name : null,
    description: typeof body.description === 'string' ? body.description : null,
    descriptionSpecified: typeof body.description === 'string',
    archived: typeof body.archived === 'boolean' ? body.archived : null,
    revision: body.revision === undefined || body.revision === null
      ? null
      : requireInteger(body.revision, 'revision'),
  };
}

async function getCategory(env: Env, categoryId: string): Promise<CategoryRow> {
  return one<CategoryRow>(
    env.DB.prepare('SELECT * FROM category WHERE id = ?').bind(categoryId),
    'Category',
    categoryId,
  );
}

async function maybeCategoryRevision(env: Env, categoryId: string): Promise<number | null> {
  const value = await env.DB.prepare(
    'SELECT lock_version FROM category WHERE id = ?',
  ).bind(categoryId).first<number>('lock_version');
  return value === null ? null : asNumber(value);
}

async function getTemplateVersion(env: Env, versionId: string): Promise<TemplateVersionRow> {
  return one<TemplateVersionRow>(
    env.DB.prepare('SELECT * FROM template_version WHERE id = ?').bind(versionId),
    'Template version',
    versionId,
  );
}

async function getTemplateSnapshot(env: Env, versionId: string): Promise<TemplateSnapshot> {
  const rows = await templateRows(
    env,
    'WHERE tv.id = ? ORDER BY tc.position, tc.criterion_id',
    [versionId],
  );
  if (rows.length === 0) {
    await getTemplateVersion(env, versionId);
    throw new Error('Unreachable');
  }
  const snapshot = groupTemplateRows(rows)[0];
  if (!snapshot) throw new Error('Template snapshot could not be assembled');
  return snapshot;
}

async function templateRows(
  env: Env,
  suffix: string,
  bindings: BindValue[],
): Promise<TemplateJoinRow[]> {
  return all<TemplateJoinRow>(
    env.DB.prepare(
      `SELECT
         tv.id,
         tv.category_id,
         tv.version,
         tv.status,
         tv.published_at,
         tv.created_at,
         tv.updated_at,
         tv.lock_version,
         tv.properties_json,
         tc.criterion_id,
         tc.name AS criterion_name,
         tc.description AS criterion_description,
         tc.min_value,
         tc.max_value,
         tc.step_value,
         tc.position AS criterion_position,
         tc.required AS criterion_required
       FROM template_version tv
       LEFT JOIN template_criterion tc ON tc.template_version_id = tv.id
       ${suffix}`,
    ).bind(...bindings),
  );
}

function groupTemplateRows(rows: TemplateJoinRow[]): TemplateSnapshot[] {
  const snapshots = new Map<string, TemplateSnapshot>();
  for (const row of rows) {
    let snapshot = snapshots.get(row.id);
    if (!snapshot) {
      snapshot = {
        version: {
          id: row.id,
          category_id: row.category_id,
          version: asNumber(row.version),
          status: row.status,
          published_at: row.published_at,
          created_at: row.created_at,
          updated_at: row.updated_at,
          lock_version: asNumber(row.lock_version),
        },
        criteria: [],
        properties: storedProperties(row.properties_json),
      };
      snapshots.set(row.id, snapshot);
    }
    if (row.criterion_id !== null) {
      if (
        row.criterion_name === null
        || row.min_value === null
        || row.max_value === null
        || row.step_value === null
        || row.criterion_position === null
        || row.criterion_required === null
      ) {
        throw new Error('Template criterion row is incomplete');
      }
      const criterion: TemplateSnapshot['criteria'][number] = {
        id: row.criterion_id,
        criterionId: row.criterion_id,
        name: row.criterion_name,
        minValue: row.min_value,
        maxValue: row.max_value,
        stepValue: row.step_value,
        position: asNumber(row.criterion_position),
        required: asBoolean(row.criterion_required),
      };
      if (row.criterion_description !== null) criterion.description = row.criterion_description;
      snapshot.criteria.push(criterion);
    }
  }
  return [...snapshots.values()];
}

function categoryDto(row: CategoryRow): {
  id: string;
  name: string;
  description?: string;
  activeTemplateVersionId?: string;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
} {
  const result: ReturnType<typeof categoryDto> = {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: asNumber(row.lock_version),
  };
  if (row.description !== null) result.description = row.description;
  if (row.active_template_version_id !== null) result.activeTemplateVersionId = row.active_template_version_id;
  if (row.archived_at !== null) result.archivedAt = row.archived_at;
  return result;
}

function templateDto(snapshot: TemplateSnapshot): {
  id: string;
  categoryId: string;
  version: number;
  status: 'draft' | 'published' | 'retired';
  criteria: TemplateSnapshot['criteria'];
  properties: PropertyDefinition[];
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
} {
  const version = snapshot.version;
  const result: ReturnType<typeof templateDto> = {
    id: version.id,
    categoryId: version.category_id,
    version: asNumber(version.version),
    status: version.status,
    criteria: snapshot.criteria,
    properties: snapshot.properties,
    createdAt: version.created_at,
    updatedAt: version.updated_at,
    revision: asNumber(version.lock_version),
  };
  if (version.published_at !== null) result.publishedAt = version.published_at;
  return result;
}

function requireDraftEditable(version: TemplateVersionRow): void {
  if (version.status !== 'draft') {
    throw new HttpError(409, 'IMMUTABLE_RESOURCE', 'Published or retired templates cannot be edited');
  }
}

function assertFields(body: Record<string, unknown>, allowed: Set<string>): void {
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new HttpError(400, 'INVALID_JSON', 'Request JSON is invalid');
  }
}

function invalidJsonField(field: string): never {
  throw new HttpError(400, 'INVALID_JSON', 'Request JSON is invalid', { field });
}

function methodNotAllowed(): never {
  throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
}
