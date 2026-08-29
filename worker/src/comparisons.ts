import Decimal from 'decimal.js';
import { all, asNumber, one } from './db';
import { EntityRow } from './entities';
import { conflict, HttpError, json, notFound, requireInstant, requireUuid } from './http';
import { getTemplateCriteria, ReviewRow, reviewDtos, TemplateCriterionRow } from './reviews';
import { Scale } from './scale';

function canonical(value: Decimal): string {
  const fixed = value.toFixed();
  return fixed.includes('.') ? fixed.replace(/(?:\.0+|(?:(\.\d*?)0+))$/, '$1') : fixed;
}

function criterionBase(criterion: TemplateCriterionRow): Record<string, unknown> {
  return {
    criterionId: criterion.criterion_id,
    id: criterion.criterion_id,
    name: criterion.name,
    position: asNumber(criterion.position),
  };
}

export async function handleComparisonRoutes(
  request: Request,
  env: Env,
  path: string[],
  method: string,
): Promise<Response | null> {
  if (path.length !== 1 || path[0] !== 'comparisons' || method !== 'GET') return null;
  const url = new URL(request.url);
  const categoryId = requireUuid(url.searchParams.get('categoryId'), 'categoryId');
  const rawEntityIds = url.searchParams.getAll('entityId');
  if (rawEntityIds.length > 100) throw new HttpError(422, 'INVALID_ARGUMENT', 'At most 100 entities can be compared');
  const entityIds = [...new Set(rawEntityIds.map((id) => requireUuid(id, 'entityId')))];
  const aggregation = (url.searchParams.get('aggregation') ?? 'latest').toLowerCase();
  if (!['latest', 'mean', 'history'].includes(aggregation)) {
    throw new HttpError(422, 'INVALID_ARGUMENT', `Unsupported value '${aggregation}'`);
  }
  const fromRaw = url.searchParams.get('from');
  const toRaw = url.searchParams.get('to');
  const reviewerRaw = url.searchParams.get('reviewerId');
  const from = fromRaw ? requireInstant(fromRaw, 'from') : null;
  const to = toRaw ? requireInstant(toRaw, 'to') : null;
  const reviewerId = reviewerRaw ? requireUuid(reviewerRaw, 'reviewerId') : null;
  if (from && to && Date.parse(from) > Date.parse(to)) {
    throw new HttpError(422, 'INVALID_ARGUMENT', 'from must be earlier than or equal to to');
  }

  const category = await one<{ active_template_version_id: string | null } & Record<string, unknown>>(
    env.DB.prepare('SELECT active_template_version_id FROM category WHERE id = ?').bind(categoryId),
    'Category', categoryId,
  );
  if (!category.active_template_version_id) conflict('The category has no active template', { categoryId });
  const criteria = await getTemplateCriteria(env.DB, category.active_template_version_id);

  let entities: EntityRow[];
  if (entityIds.length === 0) {
    entities = await all<EntityRow>(env.DB.prepare(
      `SELECT * FROM entity WHERE category_id = ? AND archived_at IS NULL
       ORDER BY lower(name), id LIMIT 100`,
    ).bind(categoryId));
  } else {
    const placeholders = entityIds.map(() => '?').join(',');
    const rows = await all<EntityRow>(env.DB.prepare(`SELECT * FROM entity WHERE id IN (${placeholders})`).bind(...entityIds));
    const byId = new Map(rows.map((row) => [row.id, row]));
    entities = entityIds.map((id) => byId.get(id) ?? notFound('Entity', id));
  }
  for (const entity of entities) {
    if (entity.category_id !== categoryId) {
      throw new HttpError(422, 'CATEGORY_MISMATCH', 'Only entities in the requested category can be compared', { entityId: entity.id });
    }
    if (entity.archived_at) conflict('Archived entities are excluded from comparisons', { entityId: entity.id });
  }

  let reviews: ReviewRow[] = [];
  if (entities.length) {
    for (let offset = 0; offset < entities.length; offset += 90) {
      const chunk = entities.slice(offset, offset + 90);
      const placeholders = chunk.map(() => '?').join(',');
      const clauses = [`entity_id IN (${placeholders})`, "status = 'final'", 'hidden_at IS NULL'];
      const bindings: Array<string> = chunk.map((entity) => entity.id);
      if (from) { clauses.push('reviewed_at >= ?'); bindings.push(from); }
      if (to) { clauses.push('reviewed_at <= ?'); bindings.push(to); }
      if (reviewerId) { clauses.push('reviewer_id = ?'); bindings.push(reviewerId); }
      reviews.push(...await all<ReviewRow>(env.DB.prepare(
        `SELECT * FROM review WHERE ${clauses.join(' AND ')}
         ORDER BY reviewed_at DESC, created_at DESC, id DESC`,
      ).bind(...bindings)));
    }
  }
  const dtos = await reviewDtos(env.DB, reviews);
  const dtoById = new Map(dtos.map((dto) => [String(dto.id), dto]));
  const reviewsByEntity = new Map<string, ReviewRow[]>();
  for (const review of reviews) {
    const list = reviewsByEntity.get(review.entity_id) ?? [];
    list.push(review); reviewsByEntity.set(review.entity_id, list);
  }

  const projectedEntities = entities.map((entity) => {
    const entityReviews = reviewsByEntity.get(entity.id) ?? [];
    const reviewDtoList = entityReviews.map((review) => dtoById.get(review.id)!);
    const latest = reviewDtoList[0];
    let projectedCriteria: Array<Record<string, unknown>>;
    if (aggregation === 'mean') {
      projectedCriteria = criteria.map((criterion) => {
        const values: Decimal[] = [];
        for (const review of reviewDtoList) {
          const scores = review.scores as Array<Record<string, unknown>>;
          const score = scores.find((item) => item.criterionId === criterion.criterion_id);
          if (score && typeof score.normalizedValue === 'number') values.push(new Decimal(score.normalizedValue));
        }
        const scale = new Scale(criterion.min_value, criterion.max_value, criterion.step_value);
        if (!values.length) {
          return { ...criterionBase(criterion), missing: true, minValue: scale.minValue(), maxValue: scale.maxValue(), sampleCount: 0 };
        }
        const mean = values.reduce((sum, value) => sum.plus(value), new Decimal(0)).div(values.length);
        return {
          ...criterionBase(criterion), missing: false,
          displayValue: canonical(scale.min.plus(scale.max.minus(scale.min).times(mean))),
          normalizedValue: mean.toNumber(),
          minValue: scale.minValue(), maxValue: scale.maxValue(), sampleCount: values.length,
        };
      });
    } else {
      const latestScores = (latest?.scores ?? []) as Array<Record<string, unknown>>;
      projectedCriteria = criteria.map((criterion) => {
        const scale = new Scale(criterion.min_value, criterion.max_value, criterion.step_value);
        const score = latestScores.find((item) => item.criterionId === criterion.criterion_id);
        return score ? {
          ...criterionBase(criterion), missing: false,
          displayValue: score.displayValue, normalizedValue: score.normalizedValue,
          minValue: score.minValue, maxValue: score.maxValue, sampleCount: 1,
        } : {
          ...criterionBase(criterion), missing: true,
          minValue: scale.minValue(), maxValue: scale.maxValue(), sampleCount: 0,
        };
      });
    }
    const normalized = projectedCriteria
      .map((criterion) => criterion.normalizedValue)
      .filter((value): value is number => typeof value === 'number');
    const overall = normalized.length
      ? new Decimal(normalized.reduce((sum, value) => sum + value, 0)).div(normalized.length).toNumber()
      : null;
    return {
      entityId: entity.id,
      entityName: entity.name,
      entity: { id: entity.id, categoryId: entity.category_id, name: entity.name },
      reviewCount: entityReviews.length,
      lastReviewedAt: entityReviews[0]?.reviewed_at ?? null,
      criteria: projectedCriteria,
      overallNormalizedValue: overall,
      history: aggregation === 'history' ? reviewDtoList : [],
    };
  });

  return json({
    categoryId,
    aggregation,
    criteria: criteria.map((criterion) => ({ ...criterionBase(criterion), missing: false, sampleCount: 0 })),
    entities: projectedEntities,
  });
}
